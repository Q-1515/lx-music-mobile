#import "AppDelegate.h"
#import <CommonCrypto/CommonCryptor.h>
#import <CommonCrypto/CommonDigest.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTBundleURLProvider.h>
#import <ReactNativeNavigation/ReactNativeNavigation.h>
#import <Security/Security.h>

static NSData *LXBase64Decode(NSString *value) {
  if (value == nil) return [NSData data];
  return [[NSData alloc] initWithBase64EncodedString:value options:NSDataBase64DecodingIgnoreUnknownCharacters] ?: [NSData data];
}

static NSString *LXBase64Encode(NSData *value) {
  if (value == nil || value.length == 0) return @"";
  return [value base64EncodedStringWithOptions:0];
}

static NSData *LXDERLength(NSUInteger length) {
  if (length < 0x80) {
    uint8_t value = (uint8_t)length;
    return [NSData dataWithBytes:&value length:1];
  }

  uint8_t lengthBytes[sizeof(NSUInteger)] = { 0 };
  NSUInteger index = sizeof(NSUInteger);
  NSUInteger value = length;
  while (value > 0) {
    index -= 1;
    lengthBytes[index] = (uint8_t)(value & 0xFF);
    value >>= 8;
  }

  uint8_t prefix = (uint8_t)(0x80 | (sizeof(NSUInteger) - index));
  NSMutableData *data = [NSMutableData dataWithBytes:&prefix length:1];
  [data appendBytes:&lengthBytes[index] length:sizeof(NSUInteger) - index];
  return data;
}

static NSData *LXDERWrap(uint8_t tag, NSData *value) {
  NSMutableData *data = [NSMutableData dataWithBytes:&tag length:1];
  [data appendData:LXDERLength(value.length)];
  [data appendData:value];
  return data;
}

static BOOL LXReadASN1Length(NSData *data, NSUInteger *index, NSUInteger *length) {
  if (*index >= data.length) return NO;

  const uint8_t *bytes = (const uint8_t *)data.bytes;
  uint8_t byte = bytes[*index];
  *index += 1;

  if ((byte & 0x80) == 0) {
    *length = byte;
    return *index + *length <= data.length;
  }

  NSUInteger byteCount = byte & 0x7F;
  if (byteCount == 0 || *index + byteCount > data.length) return NO;

  NSUInteger value = 0;
  for (NSUInteger i = 0; i < byteCount; i++) {
    value = (value << 8) | bytes[*index + i];
  }
  *index += byteCount;
  *length = value;
  return *index + *length <= data.length;
}

static NSData *LXRSAPublicKeyAlgorithmIdentifier(void) {
  static const uint8_t bytes[] = {
    0x30, 0x0D,
    0x06, 0x09,
    0x2A, 0x86, 0x48, 0x86, 0xF7, 0x0D, 0x01, 0x01, 0x01,
    0x05, 0x00,
  };
  return [NSData dataWithBytes:bytes length:sizeof(bytes)];
}

static NSData *LXWrapRSAPublicKey(NSData *publicKeyData) {
  NSMutableData *bitStringValue = [NSMutableData dataWithBytes:"\x00" length:1];
  [bitStringValue appendData:publicKeyData];

  NSMutableData *sequence = [NSMutableData dataWithData:LXRSAPublicKeyAlgorithmIdentifier()];
  [sequence appendData:LXDERWrap(0x03, bitStringValue)];
  return LXDERWrap(0x30, sequence);
}

static NSData *LXWrapRSAPrivateKey(NSData *privateKeyData) {
  static const uint8_t versionBytes[] = { 0x02, 0x01, 0x00 };
  NSData *version = [NSData dataWithBytes:versionBytes length:sizeof(versionBytes)];

  NSMutableData *sequence = [NSMutableData dataWithData:version];
  [sequence appendData:LXRSAPublicKeyAlgorithmIdentifier()];
  [sequence appendData:LXDERWrap(0x04, privateKeyData)];
  return LXDERWrap(0x30, sequence);
}

static NSData *LXStripPublicKeyHeader(NSData *data) {
  if (data.length < 1) return data;

  const uint8_t *bytes = (const uint8_t *)data.bytes;
  NSUInteger index = 0;
  NSUInteger length = 0;

  if (bytes[index] != 0x30) return data;
  index += 1;
  if (!LXReadASN1Length(data, &index, &length)) return data;
  if (index >= data.length) return data;
  if (bytes[index] == 0x02) return data;

  if (bytes[index] != 0x30) return data;
  index += 1;
  if (!LXReadASN1Length(data, &index, &length)) return data;
  index += length;
  if (index >= data.length || bytes[index] != 0x03) return data;

  index += 1;
  if (!LXReadASN1Length(data, &index, &length)) return data;
  if (index >= data.length || bytes[index] != 0x00) return data;
  index += 1;
  if (index > data.length) return data;

  return [data subdataWithRange:NSMakeRange(index, data.length - index)];
}

static NSData *LXStripPrivateKeyHeader(NSData *data) {
  if (data.length < 1) return data;

  const uint8_t *bytes = (const uint8_t *)data.bytes;
  NSUInteger index = 0;
  NSUInteger length = 0;

  if (bytes[index] != 0x30) return data;
  index += 1;
  if (!LXReadASN1Length(data, &index, &length)) return data;
  if (index >= data.length || bytes[index] != 0x02) return data;

  index += 1;
  if (!LXReadASN1Length(data, &index, &length)) return data;
  index += length;
  if (index >= data.length) return data;
  if (bytes[index] == 0x02) return data;
  if (bytes[index] != 0x30) return data;

  index += 1;
  if (!LXReadASN1Length(data, &index, &length)) return data;
  index += length;
  if (index >= data.length || bytes[index] != 0x04) return data;

  index += 1;
  if (!LXReadASN1Length(data, &index, &length)) return data;
  if (index + length > data.length) return data;

  return [data subdataWithRange:NSMakeRange(index, length)];
}

static NSError *LXError(NSString *code, NSString *message) {
  return [NSError errorWithDomain:@"CryptoModule" code:0 userInfo:@{
    NSLocalizedDescriptionKey: message,
    @"code": code,
  }];
}

static SecKeyRef LXCreateRSAKey(NSData *data, CFTypeRef keyClass, NSError **error) {
  NSData *normalizedData = CFEqual(keyClass, kSecAttrKeyClassPublic)
    ? LXStripPublicKeyHeader(data)
    : LXStripPrivateKeyHeader(data);

  NSDictionary *attributes = @{
    (__bridge id)kSecAttrKeyType: (__bridge id)kSecAttrKeyTypeRSA,
    (__bridge id)kSecAttrKeyClass: (__bridge id)keyClass,
  };

  CFErrorRef cfError = NULL;
  SecKeyRef key = SecKeyCreateWithData((__bridge CFDataRef)normalizedData, (__bridge CFDictionaryRef)attributes, &cfError);
  if (cfError != NULL) {
    if (error != NULL) *error = CFBridgingRelease(cfError);
    else CFRelease(cfError);
  }
  return key;
}

static SecKeyAlgorithm LXRSAAlgorithm(NSString *padding) {
  if ([padding isEqualToString:@"RSA/ECB/OAEPWithSHA1AndMGF1Padding"]) {
    return kSecKeyAlgorithmRSAEncryptionOAEPSHA1;
  }
  return kSecKeyAlgorithmRSAEncryptionRaw;
}

static NSDictionary *LXGenerateRSAKeyPair(NSError **error) {
  CFErrorRef cfError = NULL;
  NSDictionary *attributes = @{
    (__bridge id)kSecAttrKeyType: (__bridge id)kSecAttrKeyTypeRSA,
    (__bridge id)kSecAttrKeySizeInBits: @2048,
  };

  SecKeyRef privateKey = SecKeyCreateRandomKey((__bridge CFDictionaryRef)attributes, &cfError);
  if (privateKey == NULL) {
    if (error != NULL && cfError != NULL) *error = CFBridgingRelease(cfError);
    return nil;
  }

  SecKeyRef publicKey = SecKeyCopyPublicKey(privateKey);
  NSData *publicKeyData = (__bridge_transfer NSData *)SecKeyCopyExternalRepresentation(publicKey, &cfError);
  if (publicKeyData == nil) {
    if (error != NULL && cfError != NULL) *error = CFBridgingRelease(cfError);
    if (publicKey != NULL) CFRelease(publicKey);
    CFRelease(privateKey);
    return nil;
  }

  NSData *privateKeyData = (__bridge_transfer NSData *)SecKeyCopyExternalRepresentation(privateKey, &cfError);
  if (privateKeyData == nil) {
    if (error != NULL && cfError != NULL) *error = CFBridgingRelease(cfError);
    if (publicKey != NULL) CFRelease(publicKey);
    CFRelease(privateKey);
    return nil;
  }

  NSDictionary *result = @{
    @"publicKey": LXBase64Encode(LXWrapRSAPublicKey(publicKeyData)),
    @"privateKey": LXBase64Encode(LXWrapRSAPrivateKey(privateKeyData)),
  };

  if (publicKey != NULL) CFRelease(publicKey);
  CFRelease(privateKey);
  return result;
}

static NSString *LXRSAEncrypt(NSString *decryptedBase64, NSString *publicKeyBase64, NSString *padding, NSError **error) {
  SecKeyRef key = LXCreateRSAKey(LXBase64Decode(publicKeyBase64), kSecAttrKeyClassPublic, error);
  if (key == NULL) return nil;

  NSData *plainData = LXBase64Decode(decryptedBase64);
  SecKeyAlgorithm algorithm = LXRSAAlgorithm(padding);
  if (!SecKeyIsAlgorithmSupported(key, kSecKeyOperationTypeEncrypt, algorithm)) {
    if (error != NULL) *error = LXError(@"rsa_encrypt", @"Unsupported RSA encryption algorithm");
    CFRelease(key);
    return nil;
  }

  CFErrorRef cfError = NULL;
  NSData *encryptedData = (__bridge_transfer NSData *)SecKeyCreateEncryptedData(key, algorithm, (__bridge CFDataRef)plainData, &cfError);
  CFRelease(key);

  if (encryptedData == nil) {
    if (error != NULL && cfError != NULL) *error = CFBridgingRelease(cfError);
    return nil;
  }

  return LXBase64Encode(encryptedData);
}

static NSString *LXRSADecrypt(NSString *encryptedBase64, NSString *privateKeyBase64, NSString *padding, NSError **error) {
  SecKeyRef key = LXCreateRSAKey(LXBase64Decode(privateKeyBase64), kSecAttrKeyClassPrivate, error);
  if (key == NULL) return nil;

  NSData *encryptedData = LXBase64Decode(encryptedBase64);
  SecKeyAlgorithm algorithm = LXRSAAlgorithm(padding);
  if (!SecKeyIsAlgorithmSupported(key, kSecKeyOperationTypeDecrypt, algorithm)) {
    if (error != NULL) *error = LXError(@"rsa_decrypt", @"Unsupported RSA decryption algorithm");
    CFRelease(key);
    return nil;
  }

  CFErrorRef cfError = NULL;
  NSData *decryptedData = (__bridge_transfer NSData *)SecKeyCreateDecryptedData(key, algorithm, (__bridge CFDataRef)encryptedData, &cfError);
  CFRelease(key);

  if (decryptedData == nil) {
    if (error != NULL && cfError != NULL) *error = CFBridgingRelease(cfError);
    return nil;
  }

  NSString *result = [[NSString alloc] initWithData:decryptedData encoding:NSUTF8StringEncoding];
  return result ?: @"";
}

static NSString *LXAES(NSString *dataBase64, NSString *keyBase64, NSString *ivBase64, NSString *mode, CCOperation operation, NSError **error) {
  NSData *data = LXBase64Decode(dataBase64);
  NSData *key = LXBase64Decode(keyBase64);
  NSData *iv = LXBase64Decode(ivBase64);

  if (key.length == 0) {
    if (error != NULL) *error = LXError(@"aes_key", @"Missing AES key");
    return nil;
  }

  BOOL isCBC = [mode isEqualToString:@"AES/CBC/PKCS7Padding"];
  CCOptions options = isCBC ? kCCOptionPKCS7Padding : kCCOptionECBMode;

  char ivBuffer[kCCBlockSizeAES128] = { 0 };
  if (isCBC && iv.length > 0) {
    [iv getBytes:ivBuffer length:MIN(iv.length, sizeof(ivBuffer))];
  }

  size_t outputLength = data.length + kCCBlockSizeAES128;
  NSMutableData *output = [NSMutableData dataWithLength:outputLength];
  size_t moved = 0;

  CCCryptorStatus status = CCCrypt(
    operation,
    kCCAlgorithmAES,
    options,
    key.bytes,
    key.length,
    isCBC ? ivBuffer : NULL,
    data.bytes,
    data.length,
    output.mutableBytes,
    output.length,
    &moved
  );

  if (status != kCCSuccess) {
    if (error != NULL) *error = LXError(@"aes", [NSString stringWithFormat:@"AES operation failed: %d", status]);
    return nil;
  }

  output.length = moved;
  if (operation == kCCEncrypt) return LXBase64Encode(output);

  NSString *result = [[NSString alloc] initWithData:output encoding:NSUTF8StringEncoding];
  return result ?: @"";
}

static NSString *LXSHA1(NSString *value) {
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
  unsigned char digest[CC_SHA1_DIGEST_LENGTH];
  CC_SHA1(data.bytes, (CC_LONG)data.length, digest);

  NSMutableString *hash = [NSMutableString stringWithCapacity:CC_SHA1_DIGEST_LENGTH * 2];
  for (NSInteger i = 0; i < CC_SHA1_DIGEST_LENGTH; i++) {
    [hash appendFormat:@"%02x", digest[i]];
  }
  return hash;
}

@interface CryptoModule : NSObject<RCTBridgeModule>
@end

@implementation CryptoModule

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

RCT_REMAP_METHOD(generateRsaKey, generateRsaKeyWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSDictionary *keyPair = LXGenerateRSAKeyPair(&error);
  if (keyPair == nil) {
    reject(@"generate_rsa_key", error.localizedDescription ?: @"Failed to generate RSA key pair", error);
    return;
  }
  resolve(keyPair);
}

RCT_REMAP_METHOD(rsaEncrypt, rsaEncrypt:(NSString *)text key:(NSString *)key padding:(NSString *)padding resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSString *result = LXRSAEncrypt(text, key, padding, &error);
  if (result == nil) {
    reject(@"rsa_encrypt", error.localizedDescription ?: @"RSA encrypt failed", error);
    return;
  }
  resolve(result);
}

RCT_REMAP_METHOD(rsaDecrypt, rsaDecrypt:(NSString *)text key:(NSString *)key padding:(NSString *)padding resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSString *result = LXRSADecrypt(text, key, padding, &error);
  if (result == nil) {
    reject(@"rsa_decrypt", error.localizedDescription ?: @"RSA decrypt failed", error);
    return;
  }
  resolve(result);
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(rsaEncryptSync:(NSString *)text key:(NSString *)key padding:(NSString *)padding) {
  return LXRSAEncrypt(text, key, padding, nil) ?: @"";
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(rsaDecryptSync:(NSString *)text key:(NSString *)key padding:(NSString *)padding) {
  return LXRSADecrypt(text, key, padding, nil) ?: @"";
}

RCT_REMAP_METHOD(aesEncrypt, aesEncrypt:(NSString *)text key:(NSString *)key iv:(NSString *)iv mode:(NSString *)mode resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSString *result = LXAES(text, key, iv, mode, kCCEncrypt, &error);
  if (result == nil) {
    reject(@"aes_encrypt", error.localizedDescription ?: @"AES encrypt failed", error);
    return;
  }
  resolve(result);
}

RCT_REMAP_METHOD(aesDecrypt, aesDecrypt:(NSString *)text key:(NSString *)key iv:(NSString *)iv mode:(NSString *)mode resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSString *result = LXAES(text, key, iv, mode, kCCDecrypt, &error);
  if (result == nil) {
    reject(@"aes_decrypt", error.localizedDescription ?: @"AES decrypt failed", error);
    return;
  }
  resolve(result);
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(aesEncryptSync:(NSString *)text key:(NSString *)key iv:(NSString *)iv mode:(NSString *)mode) {
  return LXAES(text, key, iv, mode, kCCEncrypt, nil) ?: @"";
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(aesDecryptSync:(NSString *)text key:(NSString *)key iv:(NSString *)iv mode:(NSString *)mode) {
  return LXAES(text, key, iv, mode, kCCDecrypt, nil) ?: @"";
}

RCT_REMAP_METHOD(sha1, sha1:(NSString *)input resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(LXSHA1(input ?: @""));
}

@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
  RCTBridge *bridge = [[RCTBridge alloc] initWithDelegate:self launchOptions:launchOptions];
  [ReactNativeNavigation bootstrapWithBridge:bridge];
  self.initialProps = @{};

  return YES;
}

- (NSArray<id<RCTBridgeModule>> *)extraModulesForBridge:(RCTBridge *)bridge {
  return [ReactNativeNavigation extraModulesForBridge:bridge];
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self getBundleURL];
}

- (NSURL *)getBundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end
