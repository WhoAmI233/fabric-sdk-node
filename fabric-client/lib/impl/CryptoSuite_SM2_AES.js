/**
 * Copyright 2016 IBM All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */

'use strict';

// requires
var api = require('../api.js');

var elliptic = require('elliptic');
var EC = elliptic.ec;
global.navigator = require('web-midi-api');
global.window = ''/*...*/; // BUT PLEASE DON'T DO THIS, keep reading
var sm2 = require('sm2-fabric');
// var jsrsa = require('jsrsasign');
var KEYUTIL = sm2.KEYUTIL;
// var ECDSA = jsrsa.ECDSA;
var SM2 = sm2.SM2;
var SM3Digest = sm2.SM3Digest;
var util = require('util');
var BN = require('bn.js');
var Signature = require('elliptic/lib/elliptic/ec/signature.js');
var ASN1 = require('./asn1/ASN1');
var Hex = require('./asn1/hex');
var hashPrimitives = require('../hash.js');
var utils = require('../utils');
var SM2Key = require('./sm2/key.js');

var logger = utils.getLogger('crypto_sm2_aes');

/**
 * The {@link module:api.CryptoSuite} implementation for ECDSA, and AES algorithms using software key generation.
 * This class implements a software-based key generation (as opposed to Hardware Security Module based key management)
 *
 * @class
 * @extends module:api.CryptoSuite
 */
var CryptoSuite_SM2_AES = class extends api.CryptoSuite {

	/**
	 * constructor
	 *
	 * @param {number} keySize Key size for the ECDSA algorithm, can only be 256 or 384
	 * @param {string} hash Optional. Hash algorithm, supported values are "SHA2" and "SHA3"
	 */
	constructor(keySize, hash) {
		logger.debug('constructor, keySize: ' + keySize);
		super();

		if (keySize !== 256 && keySize !== 384) {
			throw new Error('Illegal key size: ' + keySize + ' - this crypto suite only supports key sizes 256 or 384');
		}
		if (typeof hash === 'string' && hash !== null && hash !== '') {
			this._hashAlgo = hash;
		} else {
			this._hashAlgo = utils.getConfigSetting('crypto-hash-algo');
		}
		this._keySize = keySize;
		this._cryptoKeyStore = null;

		this._initialize();

	}

	/**
	 * Set the cryptoKeyStore.
	 *
	 * When the application needs to use a key store other than the default,
	 * it should use the {@link Client} newCryptoKeyStore to create an instance and
	 * use this function to set the instance on the CryptoSuite.
	 *
	 * @param {CryptoKeyStore} cryptoKeyStore The cryptoKeyStore.
	 */
	setCryptoKeyStore(cryptoKeyStore) {
		this._cryptoKeyStore = cryptoKeyStore;
	}

	_initialize() {
		if (this._keySize === 256) {
			this._curveName = 'sm2';
			this._ecdsaCurve = elliptic.curves['p256'];
		} else if (this._keySize === 384) {
			this._curveName = 'secp384r1';
			this._ecdsaCurve = elliptic.curves['p384'];
		}

		// hash function must be set carefully to produce the hash size compatible with the key algorithm
		// https://www.ietf.org/rfc/rfc5480.txt (see page 9 "Recommended key size, digest algorithm and curve")

		logger.debug('Hash algorithm: %s, hash output size: %s', this._hashAlgo, this._keySize);
		switch (this._hashAlgo.toLowerCase() + '-' + this._keySize) {
			case 'sha3-256':
				this._hashFunction = hashPrimitives.SHA3_256;
				break;
			case 'sha3-384':
				this._hashFunction = hashPrimitives.SHA3_384;
				break;
			case 'sha2-256':
				this._hashFunction = hashPrimitives.SHA2_256;
				break;
			case 'sha2-384':
				this._hashFunction = hashPrimitives.SHA2_384;
				break;
			case 'sm3-256':
				this._hashFunction = hashPrimitives.SHA2_256;
				break;
			default:
				throw Error(util.format('Unsupported hash algorithm and key size pair: %s-%s', this._hashAlgo, this._keySize));
		}

		this._hashOutputSize = this._keySize / 8;

		this._ecdsa = new EC(this._ecdsaCurve);
	}

	generateKey(opts) {
		var ec = new SM2({ "curve": "sm2" })
		var pair = ec.generateKeyPairHex();
		pair.type = "SM2"
		if (typeof opts !== 'undefined' && typeof opts.ephemeral !== 'undefined' && opts.ephemeral === true) {
			logger.debug('generateKey, ephemeral true, Promise resolved');
			return Promise.resolve(new SM2Key(pair));
		} else {
			if (!this._cryptoKeyStore) {
				throw new Error('generateKey opts.ephemeral is false, which requires CryptoKeyStore to be set.');
			}
			// unless "opts.ephemeral" is explicitly set to "true", default to saving the key
			var key = new SM2Key(pair);
			try {
				var self = this;
				return new Promise((resolve, reject) => {

					self._cryptoKeyStore._getKeyStore()
						.then((store) => {
							logger.debug('generateKey, store.setValue');

							return store.putKey(key)
								.then(() => {

									return resolve(key);
								}).catch((err) => {

									reject(err);
								});
						});

				});
			} catch (err) {
				console.log("error" + err)
			};
		}
	}

	/**
	 * This is an implementation of {@link module:api.CryptoSuite#deriveKey}
	 * To be implemented
	 */
	deriveKey(key, opts) {
		if (key || opts);
		throw new Error('Not implemented yet');
	}

	/**
	 * This is an implementation of {@link module:api.CryptoSuite#importKey}
	 * To be implemented
	 */
	importKey(pem, opts) {
		logger.debug('importKey - start pem :', pem);
		var store_key = true; //default
		if (typeof opts !== 'undefined' && typeof opts.ephemeral !== 'undefined' && opts.ephemeral === true) {
			store_key = false;
		}
		if (!!store_key && !this._cryptoKeyStore) {
			throw new Error('importKey opts.ephemeral is false, which requires CryptoKeyStore to be set.');
		}

		var self = this;
		// attempt to import the raw content, assuming it's one of the following:
		// X.509v1/v3 PEM certificate (RSA/DSA/ECC)
		// PKCS#8 PEM RSA/DSA/ECC public key
		// PKCS#5 plain PEM DSA/RSA private key
		// PKCS#8 plain PEM RSA/ECDSA private key
		// TODO: add support for the following passcode-protected PEM formats
		// - PKCS#5 encrypted PEM RSA/DSA private
		// - PKCS#8 encrypted PEM RSA/ECDSA private key
		var pemString = Buffer.from(pem).toString();
		pemString = makeRealPem(pemString);
		var key = null;
		var theKey = null;
		var error = null;
		try {
			if (pemString.indexOf("-END PRIVATE KEY-") != -1) {
				var reHex = /^\s*(?:[0-9A-Fa-f][0-9A-Fa-f]\s*)+$/
				var privKey = getHexFromPEM(pemString, "PRIVATE KEY")
				var der = reHex.test(privKey) ? Hex.decode(privKey) : Base64.unarmor(privKey);
				var asn1 = ASN1.decode(der, 1);
				key = new SM2({ 'curve': 'sm2' });
				var charlen = key.ecparams['keylen'] / 4;
				var epPub = key.ecparams['G'].multiply(new sm2.BigInteger(asn1, 16))
				var biX = epPub.getX().toBigInteger();
				var biY = epPub.getY().toBigInteger();
				var hX = ("0000000000" + biX.toString(16)).slice(- charlen);
				var hY = ("0000000000" + biY.toString(16)).slice(- charlen);
				var hPub = "04" + hX + hY;
				key.setPrivateKeyHex(asn1)
				key.setPublicKeyHex(hPub)
			} else {
				key = KEYUTIL.getKey(pemString);
			}
		} catch (err) {
			error = new Error('Failed to parse key from PEM: ' + err);
			throw error;
		}
		key.type = 'SM2';
		if (key && key.type && key.type === 'SM2') {
			theKey = new SM2Key(key);
			logger.debug('importKey - have the key %j', theKey);
		}
		else {
			error = new Error('Does not understand PEM contents other than ECDSA private keys and certificates');
		}

		if (!store_key) {
			if (error) {
				logger.error('importKey - %s', error);
				throw error;
			}
			return theKey;
		}
		else {
			if (error) {
				logger.error('importKey - %j', error);
				return Promise.reject(error);
			}
			return new Promise((resolve, reject) => {
				return self._cryptoKeyStore._getKeyStore()
					.then((store) => {
						return store.putKey(theKey);
					}).then(() => {
						return resolve(theKey);
					}).catch((err) => {
						reject(err);
					});

			});
		}
	}

	getKey(ski) {
		var self = this;
		var store;

		if (!self._cryptoKeyStore) {
			throw new Error('getKey requires CryptoKeyStore to be set.');
		}
		return new Promise((resolve, reject) => {
			self._cryptoKeyStore._getKeyStore()
				.then((st) => {
					store = st;
					return store.getKey(ski);
				}).then((key) => {
					if (SM2Key.isInstance(key))
						return resolve(key);

					if (key !== null) {
						var pubKey = KEYUTIL.getKey(key);
						return resolve(new SM2Key(pubKey));
					}
				}).catch((err) => {
					reject(err);
				});

		});
	}

	/**
	 * This is an implementation of {@link module:api.CryptoSuite#hash}
	 * The opts argument is not supported.
	 */
	hash(msg, opts) {
		if (opts);
		return this._hashFunction(msg);
	}

	/**
	 * This is an implementation of {@link module:api.CryptoSuite#sign}
	 * Signs digest using key k.
	 */
	sign(key, digest) {
		logger.debug("signing~~~~~~ key = %v ", key," digest = %s", digest.toString('base64'))
		if (typeof key === 'undefined' || key === null) {
			throw new Error('A valid key is required to sign');
		}

		if (typeof digest === 'undefined' || digest === null) {
			throw new Error('A valid message is required to sign');
		}

		// Note that the statement below uses internal implementation specific to the
		// module './ecdsa/key.js'
		// var signKey = this._ecdsa.keyFromPrivate(key._key.prvKeyHex, 'hex');
		// var sig = this._ecdsa.sign(digest, signKey);
		// sig = _preventMalleability(sig, key._key.ecparams);
		// logger.debug('ecdsa signature: ', sig);
		// return sig.toDER();
		var ec = new SM2({ 'curve': 'sm2' });
		// var signKey = ec.keyFromPrivate(key._key.prvKeyHex, 'hex')
		var sig = ec.sign(digest.toString("hex"), key);
		sig.s = new BN(sig.s, 16)
		sig.r = new BN(sig.r, 16)
		var tmp = new Signature(sig);
		tmp.r = sig.r
		tmp.s = sig.s
		tmp.recoveryParam = 1
		logger.debug('sm2 signature: ', tmp, "\n sig.r :", sig.r.toString(), "\n sig.s :", sig.s.toString());
		// sig = _preventMalleability(tmp, key._key.ecparams);

		return tmp.toDER();
	}

	verify(key, signature, digest) {
		if (typeof key === 'undefined' || key === null) {
			throw new Error('A valid key is required to verify');
		}

		if (typeof signature === 'undefined' || signature === null) {
			throw new Error('A valid signature is required to verify');
		}

		if (typeof digest === 'undefined' || digest === null) {
			throw new Error('A valid message is required to verify');
		}

		if (!_checkMalleability(signature, key._key.ecparams)) {
			logger.error(new Error('Invalid S value in signature. Must be smaller than half of the order.').stack);
			return false;
		}

		// var pubKey = this._ecdsa.keyFromPublic(key.getPublicKey()._key.pubKeyHex, 'hex');
		// note that the signature is generated on the hash of the message, not the message itself
		// return pubKey.verify(this.hash(digest), signature);
		var ec = SM2({ 'curve': 'sm2' });
		var result = ec.verifyHex(this.hash(digest), signature, key.getPublicKey()._key.pubKeyHex);
		return result
	}

	/**
	 * This is an implementation of {@link module:api.CryptoSuite#encrypt}
	 * To be implemented.
	 */
	encrypt(key, plainText, opts) {
		if (key || plainText || opts);
		throw new Error('Not implemented yet');
	}

	/**
	 * This is an implementation of {@link module:api.CryptoSuite#decrypt}
	 * To be implemented.
	 */
	decrypt(key, cipherText, opts) {
		if (key || cipherText || opts);
		throw new Error('Not implemented yet');
	}
};

// [Angelo De Caro] ECDSA signatures do not have unique representation and this can facilitate
// replay attacks and more. In order to have a unique representation,
// this change-set forses BCCSP to generate and accept only signatures
// with low-S.
// Bitcoin has also addressed this issue with the following BIP:
// https://github.com/bitcoin/bips/blob/master/bip-0062.mediawiki
// Before merging this change-set, we need to ensure that client-sdks
// generates signatures properly in order to avoid massive rejection
// of transactions.

// map for easy lookup of the "N/2" value per elliptic curve
const halfOrdersForCurve = {
	'sm2': elliptic.curves['p256'].n.shrn(1),
	'secp384r1': elliptic.curves['p384'].n.shrn(1)
};

function _preventMalleability(sig, curveParams) {
	var halfOrder = halfOrdersForCurve[curveParams.name];
	if (!halfOrder) {
		throw new Error('Can not find the half order needed to calculate "s" value for immalleable signatures. Unsupported curve name: ' + curveParams.name);
	}

	// in order to guarantee 's' falls in the lower range of the order, as explained in the above link,
	// first see if 's' is larger than half of the order, if so, it needs to be specially treated
	if (sig.s.cmp(halfOrder) == 1) { // module 'bn.js', file lib/bn.js, method cmp()
		// convert from BigInteger used by sm2 Key objects and bn.js used by elliptic Signature objects
		var bigNum = new BN(curveParams.n.toString(16), 16);
		sig.s = bigNum.sub(sig.s);
	}

	return sig;
}

function _checkMalleability(sig, curveParams) {
	var halfOrder = halfOrdersForCurve[curveParams.name];
	if (!halfOrder) {
		throw new Error('Can not find the half order needed to calculate "s" value for immalleable signatures. Unsupported curve name: ' + curveParams.name);
	}

	// first need to unmarshall the signature bytes into the object with r and s values
	var sigObject = new Signature(sig, 'hex');
	if (!sigObject.r || !sigObject.s) {
		throw new Error('Failed to load the signature object from the bytes.');
	}

	// in order to guarantee 's' falls in the lower range of the order, as explained in the above link,
	// first see if 's' is larger than half of the order, if so, it is considered invalid in this context
	if (sigObject.s.cmp(halfOrder) == 1) { // module 'bn.js', file lib/bn.js, method cmp()
		return false;
	}

	return true;
}

// Utilitly method to make sure the start and end markers are correct
function makeRealPem(pem) {
	var result = null;
	if (typeof pem == 'string') {
		result = pem.replace(/-----BEGIN -----/, '-----BEGIN CERTIFICATE-----');
		result = result.replace(/-----END -----/, '-----END CERTIFICATE-----');
		result = result.replace(/-----([^-]+) ECDSA ([^-]+)-----([^-]*)-----([^-]+) ECDSA ([^-]+)-----/, '-----$1 EC $2-----$3-----$4 EC $5-----');
	}
	return result;
}

var BI_RM = "0123456789abcdefghijklmnopqrstuvwxyz";
function getHexFromPEM(sPEM, sHead) {
	var s = sPEM;
	if (s.indexOf("-----BEGIN ") == -1) {
		throw "can't find PEM header: " + sHead;
	}
	if (typeof sHead == "string" && sHead != "") {
		s = s.replace("-----BEGIN " + sHead + "-----", "");
		s = s.replace("-----END " + sHead + "-----", "");
	} else {
		s = s.replace(/-----BEGIN [^-]+-----/, '');
		s = s.replace(/-----END [^-]+-----/, '');
	}
	var sB64 = s.replace(/\s+/g, '');
	var dataHex = b64tohex(sB64);
	return dataHex;
}
var b64map = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var b64pad = "=";
// convert a base64 string to hex
function b64tohex(s) {
	var ret = ""
	var i;
	var k = 0; // b64 state, 0-3
	var slop;
	var v;
	for (i = 0; i < s.length; ++i) {
		if (s.charAt(i) == b64pad) break;
		v = b64map.indexOf(s.charAt(i));
		if (v < 0) continue;
		if (k == 0) {
			ret += int2char(v >> 2);
			slop = v & 3;
			k = 1;
		}
		else if (k == 1) {
			ret += int2char((slop << 2) | (v >> 4));
			slop = v & 0xf;
			k = 2;
		}
		else if (k == 2) {
			ret += int2char(slop);
			ret += int2char(v >> 2);
			slop = v & 3;
			k = 3;
		}
		else {
			ret += int2char((slop << 2) | (v >> 4));
			ret += int2char(v & 0xf);
			k = 0;
		}
	}
	if (k == 1)
		ret += int2char(slop << 2);
	return ret;
}
function int2char(n) { return BI_RM.charAt(n); }

module.exports = CryptoSuite_SM2_AES;
