#import "AppDelegate.h"
#import <CommonCrypto/CommonCryptor.h>
#import <CommonCrypto/CommonDigest.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTBundleURLProvider.h>
#import <React/RCTEventEmitter.h>
#import <ReactNativeNavigation/ReactNativeNavigation.h>
#import <Security/Security.h>
#import <AVFoundation/AVFoundation.h>
#import <MediaPlayer/MediaPlayer.h>
#import <JavaScriptCore/JavaScriptCore.h>
#import <math.h>

#if __has_include(<FLAC/stream_decoder.h>)
#import <FLAC/stream_decoder.h>
#define LX_HAS_LIBFLAC 1
#else
#define LX_HAS_LIBFLAC 0
#endif

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

static double LXClampDouble(double value, double minValue, double maxValue) {
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
}

static UIColor *LXColorFromString(NSString *value, UIColor *fallback) {
  if (![value isKindOfClass:[NSString class]] || value.length == 0) return fallback;
  NSString *text = [[value stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]] lowercaseString];

  if ([text hasPrefix:@"#"]) {
    NSString *hex = [text substringFromIndex:1];
    unsigned long long hexValue = 0;
    if (![[NSScanner scannerWithString:hex] scanHexLongLong:&hexValue]) return fallback;

    if (hex.length == 6) {
      return [UIColor colorWithRed:((hexValue >> 16) & 0xFF) / 255.0
                             green:((hexValue >> 8) & 0xFF) / 255.0
                              blue:(hexValue & 0xFF) / 255.0
                             alpha:1];
    }
    if (hex.length == 8) {
      return [UIColor colorWithRed:((hexValue >> 24) & 0xFF) / 255.0
                             green:((hexValue >> 16) & 0xFF) / 255.0
                              blue:((hexValue >> 8) & 0xFF) / 255.0
                             alpha:(hexValue & 0xFF) / 255.0];
    }
    return fallback;
  }

  NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"rgba?\\s*\\(([^\\)]+)\\)" options:0 error:nil];
  NSTextCheckingResult *match = [regex firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
  if (match == nil || match.numberOfRanges < 2) return fallback;

  NSString *params = [text substringWithRange:[match rangeAtIndex:1]];
  NSArray<NSString *> *parts = [params componentsSeparatedByString:@","];
  if (parts.count < 3) return fallback;

  CGFloat rgba[4] = { 0, 0, 0, 1 };
  for (NSInteger i = 0; i < MIN(parts.count, 4); i++) {
    NSString *component = [parts[i] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    rgba[i] = i == 3 ? MAX(MIN(component.doubleValue, 1), 0) : MAX(MIN(component.doubleValue / 255.0, 1), 0);
  }
  return [UIColor colorWithRed:rgba[0] green:rgba[1] blue:rgba[2] alpha:rgba[3]];
}

static BOOL LXColorNeedsDarkText(UIColor *color) {
  CGFloat red = 0;
  CGFloat green = 0;
  CGFloat blue = 0;
  CGFloat alpha = 0;
  if (![color getRed:&red green:&green blue:&blue alpha:&alpha]) return YES;
  CGFloat luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return luminance > 0.62;
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
  // Android uses Cipher.getInstance("AES") for this mode, which applies ECB with PKCS padding.
  // Match that behavior on iOS so encrypted requests produce the same payloads cross-platform.
  BOOL usesAndroidCompatibleECBPadding = [mode isEqualToString:@"AES"];
  CCOptions options = 0;
  if (isCBC || usesAndroidCompatibleECBPadding) options |= kCCOptionPKCS7Padding;
  if (!isCBC) options |= kCCOptionECBMode;

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

static NSString *LXJSONString(id value) {
  if (value == nil || value == (id)kCFNull) return nil;
  if ([value isKindOfClass:[NSString class]]) return value;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
  if (!data) return nil;
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

static NSString *LXJoinJSArguments(NSArray<JSValue *> *arguments) {
  NSMutableArray<NSString *> *parts = [NSMutableArray arrayWithCapacity:arguments.count];
  for (JSValue *value in arguments) {
    if (value.isUndefined || value.isNull) {
      [parts addObject:@"null"];
      continue;
    }
    NSString *text = value.toString;
    [parts addObject:text ?: @"null"];
  }
  return [parts componentsJoinedByString:@" "];
}

static NSArray<NSString *> *LXCacheDirectories(void) {
  NSMutableArray<NSString *> *paths = [NSMutableArray array];
  NSString *cachePath = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
  if (cachePath.length) [paths addObject:cachePath];
  NSString *tempPath = NSTemporaryDirectory();
  if (tempPath.length && ![paths containsObject:tempPath]) [paths addObject:tempPath];
  return paths;
}

static BOOL LXShouldSkipManagedCacheEntry(NSString *relativePath) {
  if (!relativePath.length) return NO;
  return [relativePath isEqualToString:@"TrackPlayer"] || [relativePath hasPrefix:@"TrackPlayer/"];
}

static unsigned long long LXDirectorySize(NSString *directoryPath) {
  if (!directoryPath.length) return 0;

  NSFileManager *fileManager = [NSFileManager defaultManager];
  BOOL isDirectory = NO;
  if (![fileManager fileExistsAtPath:directoryPath isDirectory:&isDirectory] || !isDirectory) return 0;

  unsigned long long total = 0;
  NSDirectoryEnumerator *enumerator = [fileManager enumeratorAtPath:directoryPath];
  for (NSString *itemPath in enumerator) {
    if (LXShouldSkipManagedCacheEntry(itemPath)) {
      [enumerator skipDescendants];
      continue;
    }
    NSString *fullPath = [directoryPath stringByAppendingPathComponent:itemPath];
    NSDictionary *attributes = [fileManager attributesOfItemAtPath:fullPath error:nil];
    if ([attributes[NSFileType] isEqualToString:NSFileTypeDirectory]) continue;
    total += [attributes[NSFileSize] unsignedLongLongValue];
  }
  return total;
}

static BOOL LXClearDirectoryContents(NSString *directoryPath, NSError **error) {
  if (!directoryPath.length) return YES;

  NSFileManager *fileManager = [NSFileManager defaultManager];
  NSArray<NSString *> *contents = [fileManager contentsOfDirectoryAtPath:directoryPath error:error];
  if (contents == nil) return NO;

  for (NSString *name in contents) {
    if (LXShouldSkipManagedCacheEntry(name)) continue;
    NSString *fullPath = [directoryPath stringByAppendingPathComponent:name];
    if (![fileManager removeItemAtPath:fullPath error:error]) return NO;
  }
  return YES;
}

static NSURLSessionDataTask *LXNowPlayingArtworkTask = nil;
static NSMutableDictionary *LXNowPlayingInfoCache = nil;
static NSString *LXNowPlayingArtworkPath = nil;
static NSUInteger LXNowPlayingArtworkRequestId = 0;
static MPNowPlayingPlaybackState LXNowPlayingState = MPNowPlayingPlaybackStateStopped;
static NSString * const LXTrackPlayerLifecycleNotificationName = @"LXTrackPlayerLifecycle";
static id LXTrackPlayerLifecycleObserver = nil;

static NSMutableDictionary *LXNowPlayingMutableInfo(void) {
  if (LXNowPlayingInfoCache == nil) LXNowPlayingInfoCache = [NSMutableDictionary dictionary];
  return LXNowPlayingInfoCache;
}

static void LXApplyNowPlayingInfo(void) {
  MPNowPlayingInfoCenter *center = [MPNowPlayingInfoCenter defaultCenter];
  center.nowPlayingInfo = LXNowPlayingInfoCache.count ? [LXNowPlayingInfoCache copy] : nil;
  if (@available(iOS 13.0, *)) {
    center.playbackState = LXNowPlayingState;
  }
}

static void LXCancelNowPlayingArtworkTask(void) {
  if (LXNowPlayingArtworkTask != nil) {
    [LXNowPlayingArtworkTask cancel];
    LXNowPlayingArtworkTask = nil;
  }
}

static void LXApplyNowPlayingArtwork(UIImage *image, NSUInteger requestId) {
  if (image == nil) return;

  dispatch_async(dispatch_get_main_queue(), ^{
    if (requestId != LXNowPlayingArtworkRequestId) return;
    NSMutableDictionary *info = LXNowPlayingMutableInfo();
    MPMediaItemArtwork *artwork = [[MPMediaItemArtwork alloc] initWithBoundsSize:image.size requestHandler:^UIImage * _Nonnull(CGSize size) {
      return image;
    }];
    info[MPMediaItemPropertyArtwork] = artwork;
    LXApplyNowPlayingInfo();
  });
}

static void LXSetNowPlayingArtwork(NSString *artworkPath) {
  NSMutableDictionary *info = LXNowPlayingMutableInfo();
  BOOL hasArtwork = info[MPMediaItemPropertyArtwork] != nil;
  if (!artworkPath.length && LXNowPlayingArtworkPath == nil && !hasArtwork) return;
  if (artworkPath.length && [artworkPath isEqualToString:LXNowPlayingArtworkPath] && (hasArtwork || LXNowPlayingArtworkTask != nil)) return;

  LXCancelNowPlayingArtworkTask();
  LXNowPlayingArtworkRequestId += 1;
  [info removeObjectForKey:MPMediaItemPropertyArtwork];
  LXNowPlayingArtworkPath = artworkPath.length ? [artworkPath copy] : nil;
  LXApplyNowPlayingInfo();

  if (!artworkPath.length) return;

  NSUInteger requestId = LXNowPlayingArtworkRequestId;
  void (^setArtwork)(UIImage *) = ^(UIImage *image) {
    LXApplyNowPlayingArtwork(image, requestId);
  };

  if ([artworkPath hasPrefix:@"http://"] || [artworkPath hasPrefix:@"https://"]) {
    NSURL *url = [NSURL URLWithString:artworkPath];
    if (url == nil) return;
    LXNowPlayingArtworkTask = [[NSURLSession sharedSession] dataTaskWithURL:url completionHandler:^(NSData * _Nullable data, NSURLResponse * _Nullable response, NSError * _Nullable error) {
      if (error != nil || data.length == 0) return;
      UIImage *image = [UIImage imageWithData:data];
      setArtwork(image);
    }];
    [LXNowPlayingArtworkTask resume];
    return;
  }

  UIImage *image = [UIImage imageWithContentsOfFile:artworkPath];
  setArtwork(image);
}

static NSNumber *LXDefaultNowPlayingRate(void) {
  switch (LXNowPlayingState) {
    case MPNowPlayingPlaybackStatePlaying:
      return @1;
    case MPNowPlayingPlaybackStatePaused:
    case MPNowPlayingPlaybackStateStopped:
    default:
      return @0;
  }
}

static NSNumber *LXCurrentNowPlayingRate(void) {
  NSNumber *rate = [LXNowPlayingInfoCache[MPNowPlayingInfoPropertyPlaybackRate] isKindOfClass:[NSNumber class]] ? LXNowPlayingInfoCache[MPNowPlayingInfoPropertyPlaybackRate] : nil;
  return rate ?: LXDefaultNowPlayingRate();
}

static void LXSetNowPlayingPlaybackState(MPNowPlayingPlaybackState state, NSDictionary *options) {
  LXNowPlayingState = state;

  NSMutableDictionary *info = LXNowPlayingMutableInfo();
  NSDictionary *stateOptions = options ?: @{};
  NSNumber *elapsedTime = [stateOptions[@"elapsedTime"] isKindOfClass:[NSNumber class]] ? stateOptions[@"elapsedTime"] : nil;
  NSNumber *playbackRate = [stateOptions[@"playbackRate"] isKindOfClass:[NSNumber class]] ? stateOptions[@"playbackRate"] : nil;

  if (elapsedTime != nil) info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsedTime;
  else if (state == MPNowPlayingPlaybackStateStopped) info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = @0;

  info[MPNowPlayingInfoPropertyPlaybackRate] = playbackRate ?: LXDefaultNowPlayingRate();
  LXApplyNowPlayingInfo();
}

static void LXClearNowPlayingInfo(void) {
  LXCancelNowPlayingArtworkTask();
  LXNowPlayingArtworkRequestId += 1;
  LXNowPlayingArtworkPath = nil;
  LXNowPlayingInfoCache = nil;
  LXNowPlayingState = MPNowPlayingPlaybackStateStopped;
  LXApplyNowPlayingInfo();
}

static void LXHandleTrackPlayerLifecycleNotification(NSNotification *notification) {
  NSDictionary *userInfo = [notification.userInfo isKindOfClass:[NSDictionary class]] ? notification.userInfo : @{};
  NSString *event = [userInfo[@"event"] isKindOfClass:[NSString class]] ? userInfo[@"event"] : @"";
  NSString *state = [userInfo[@"state"] isKindOfClass:[NSString class]] ? userInfo[@"state"] : @"";
  NSNumber *position = [userInfo[@"position"] isKindOfClass:[NSNumber class]] ? userInfo[@"position"] : nil;
  NSNumber *rate = [userInfo[@"rate"] isKindOfClass:[NSNumber class]] ? userInfo[@"rate"] : nil;

  if ([event isEqualToString:@"destroy"] || [event isEqualToString:@"reset"]) {
    LXClearNowPlayingInfo();
    return;
  }

  if (LXNowPlayingInfoCache.count == 0) return;

  if ([event isEqualToString:@"seek"]) {
    LXSetNowPlayingPlaybackState(LXNowPlayingState, @{
      @"elapsedTime": position ?: @0,
      @"playbackRate": LXCurrentNowPlayingRate(),
    });
    return;
  }

  if ([event isEqualToString:@"error"]) {
    LXSetNowPlayingPlaybackState(MPNowPlayingPlaybackStatePaused, @{
      @"elapsedTime": position ?: @0,
      @"playbackRate": @0,
    });
    return;
  }

  if ([event isEqualToString:@"stop"]) {
    LXSetNowPlayingPlaybackState(MPNowPlayingPlaybackStateStopped, @{
      @"elapsedTime": @0,
      @"playbackRate": @0,
    });
    return;
  }

  if (![event isEqualToString:@"state"]) return;

  if ([state isEqualToString:@"playing"]) {
    LXSetNowPlayingPlaybackState(MPNowPlayingPlaybackStatePlaying, @{
      @"elapsedTime": position ?: @0,
      @"playbackRate": rate ?: LXCurrentNowPlayingRate(),
    });
    return;
  }

  if ([state isEqualToString:@"paused"] || [state isEqualToString:@"ready"] || [state isEqualToString:@"loading"]) {
    LXSetNowPlayingPlaybackState(MPNowPlayingPlaybackStatePaused, @{
      @"elapsedTime": position ?: @0,
      @"playbackRate": @0,
    });
    return;
  }

  if ([state isEqualToString:@"idle"]) {
    LXSetNowPlayingPlaybackState(MPNowPlayingPlaybackStateStopped, @{
      @"elapsedTime": @0,
      @"playbackRate": @0,
    });
  }
}

static void LXRegisterTrackPlayerLifecycleObserver(void) {
  if (LXTrackPlayerLifecycleObserver != nil) return;
  LXTrackPlayerLifecycleObserver = [[NSNotificationCenter defaultCenter] addObserverForName:LXTrackPlayerLifecycleNotificationName object:nil queue:[NSOperationQueue mainQueue] usingBlock:^(NSNotification * _Nonnull note) {
    LXHandleTrackPlayerLifecycleNotification(note);
  }];
}

static void LXSetNowPlayingInfo(NSDictionary *metadata) {
  NSMutableDictionary *info = LXNowPlayingMutableInfo();

  NSString *title = [metadata[@"title"] isKindOfClass:[NSString class]] ? metadata[@"title"] : nil;
  NSString *artist = [metadata[@"artist"] isKindOfClass:[NSString class]] ? metadata[@"artist"] : nil;
  NSString *album = [metadata[@"album"] isKindOfClass:[NSString class]] ? metadata[@"album"] : nil;
  NSNumber *duration = [metadata[@"duration"] isKindOfClass:[NSNumber class]] ? metadata[@"duration"] : nil;
  NSNumber *elapsedTime = [metadata[@"elapsedTime"] isKindOfClass:[NSNumber class]] ? metadata[@"elapsedTime"] : nil;
  NSNumber *playbackRate = [metadata[@"playbackRate"] isKindOfClass:[NSNumber class]] ? metadata[@"playbackRate"] : nil;
  NSString *artworkPath = [metadata[@"artwork"] isKindOfClass:[NSString class]] ? metadata[@"artwork"] : @"";

  if (title != nil) info[MPMediaItemPropertyTitle] = title;
  if (artist != nil) info[MPMediaItemPropertyArtist] = artist;
  if (album != nil) info[MPMediaItemPropertyAlbumTitle] = album;
  if (duration != nil) info[MPMediaItemPropertyPlaybackDuration] = duration;
  if (elapsedTime != nil) info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsedTime;
  info[MPNowPlayingInfoPropertyPlaybackRate] = playbackRate ?: info[MPNowPlayingInfoPropertyPlaybackRate] ?: LXDefaultNowPlayingRate();

  LXApplyNowPlayingInfo();
  LXSetNowPlayingArtwork(artworkPath);
}

static UIViewController *LXTopViewController(void) {
  UIWindow *window = nil;
  if (@available(iOS 13.0, *)) {
    for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
      if (![scene isKindOfClass:[UIWindowScene class]]) continue;
      UIWindowScene *windowScene = (UIWindowScene *)scene;
      for (UIWindow *sceneWindow in windowScene.windows) {
        if (sceneWindow.isKeyWindow) {
          window = sceneWindow;
          break;
        }
      }
      if (window != nil) break;
    }
  }
  if (window == nil) {
    for (UIWindow *appWindow in UIApplication.sharedApplication.windows) {
      if (appWindow.isKeyWindow) {
        window = appWindow;
        break;
      }
    }
  }
  if (window == nil) window = UIApplication.sharedApplication.windows.firstObject;

  UIViewController *controller = window.rootViewController;
  if (controller == nil) return nil;
  while (controller.presentedViewController != nil) controller = controller.presentedViewController;
  return controller;
}

static NSDictionary *LXFileInfoFromPath(NSString *path) {
  NSFileManager *fileManager = [NSFileManager defaultManager];
  BOOL isDirectory = NO;
  [fileManager fileExistsAtPath:path isDirectory:&isDirectory];
  NSDictionary *attributes = [fileManager attributesOfItemAtPath:path error:nil] ?: @{};
  NSDate *modifiedDate = attributes[NSFileModificationDate] ?: [NSDate date];
  NSString *name = path.lastPathComponent ?: @"";
  return @{
    @"name": name,
    @"path": path ?: @"",
    @"size": attributes[NSFileSize] ?: @0,
    @"isDirectory": @(isDirectory),
    @"isFile": @(!isDirectory),
    @"lastModified": @((long long)(modifiedDate.timeIntervalSince1970 * 1000)),
    @"mimeType": [NSNull null],
    @"canRead": @([fileManager isReadableFileAtPath:path ?: @""]),
  };
}

static NSString *LXPrepareImportedFilePath(NSString *targetPath, NSURL *sourceURL, NSError **error) {
  NSFileManager *fileManager = [NSFileManager defaultManager];
  NSString *basePath = targetPath.length ? targetPath : NSTemporaryDirectory();
  BOOL isDirectory = NO;
  BOOL exists = [fileManager fileExistsAtPath:basePath isDirectory:&isDirectory];

  if (!exists || isDirectory || basePath.pathExtension.length == 0) {
    if (![fileManager fileExistsAtPath:basePath]) {
      if (![fileManager createDirectoryAtPath:basePath withIntermediateDirectories:YES attributes:nil error:error]) return nil;
    }
    NSString *fileName = sourceURL.lastPathComponent.length ? sourceURL.lastPathComponent : [NSString stringWithFormat:@"%@.tmp", NSUUID.UUID.UUIDString];
    return [basePath stringByAppendingPathComponent:fileName];
  }

  NSString *parentPath = [basePath stringByDeletingLastPathComponent];
  if (parentPath.length && ![fileManager fileExistsAtPath:parentPath]) {
    if (![fileManager createDirectoryAtPath:parentPath withIntermediateDirectories:YES attributes:nil error:error]) return nil;
  }
  return basePath;
}

static NSArray<NSString *> *LXDocumentTypesForExtensions(id extTypes) {
  if (![extTypes isKindOfClass:[NSArray class]]) return @[ @"public.data", @"public.item" ];

  NSMutableOrderedSet<NSString *> *types = [NSMutableOrderedSet orderedSet];
  BOOL needsGenericDataType = NO;
  for (id item in (NSArray *)extTypes) {
    if (![item isKindOfClass:[NSString class]]) continue;
    NSString *ext = ((NSString *)item).lowercaseString;
    if (!ext.length) continue;

    if ([ext isEqualToString:@"js"]) {
      [types addObject:@"com.netscape.javascript-source"];
      [types addObject:@"public.text"];
      continue;
    }
    if ([ext isEqualToString:@"json"]) {
      [types addObject:@"public.json"];
      continue;
    }
    if ([ext isEqualToString:@"lxmc"]) {
      needsGenericDataType = YES;
      continue;
    }
    if ([ext isEqualToString:@"bin"]) {
      needsGenericDataType = YES;
      continue;
    }
    if ([ext isEqualToString:@"jpg"] || [ext isEqualToString:@"jpeg"]) {
      [types addObject:@"public.jpeg"];
      continue;
    }
    if ([ext isEqualToString:@"png"]) {
      [types addObject:@"public.png"];
      continue;
    }
    if ([ext isEqualToString:@"gif"]) {
      [types addObject:@"com.compuserve.gif"];
      continue;
    }
    if ([ext isEqualToString:@"txt"] || [ext isEqualToString:@"lrc"]) {
      [types addObject:@"public.plain-text"];
      continue;
    }
    if ([ext isEqualToString:@"mp3"]) {
      [types addObject:@"public.mp3"];
      continue;
    }
    if ([ext isEqualToString:@"m4a"] || [ext isEqualToString:@"aac"]) {
      [types addObject:@"public.audio"];
      continue;
    }
    if ([ext isEqualToString:@"wav"]) {
      [types addObject:@"com.microsoft.waveform-audio"];
      continue;
    }
    if ([ext isEqualToString:@"flac"] || [ext isEqualToString:@"ogg"]) {
      [types addObject:@"public.audio"];
      continue;
    }

    needsGenericDataType = YES;
  }

  if (needsGenericDataType) {
    [types addObject:@"public.data"];
    [types addObject:@"public.item"];
  }

  return types.count ? types.array : @[ @"public.data", @"public.item" ];
}

@interface FlacPlayerModule : RCTEventEmitter<RCTBridgeModule, AVAudioPlayerDelegate>
@property (nonatomic, strong) AVAudioPlayer *player;
@property (nonatomic, copy) NSString *currentPath;
@property (nonatomic, copy) NSString *currentState;
@property (nonatomic, assign) BOOL hasListeners;
@property (nonatomic, assign) BOOL manualPause;
@property (nonatomic, assign) BOOL interruptedBySystem;
@end

@implementation FlacPlayerModule

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _currentState = @"idle";
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(handleAudioSessionInterruption:)
                                                 name:AVAudioSessionInterruptionNotification
                                               object:[AVAudioSession sharedInstance]];
  }
  return self;
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (NSArray<NSString *> *)supportedEvents {
  return @[ @"flac-player-event" ];
}

- (void)startObserving {
  self.hasListeners = YES;
}

- (void)stopObserving {
  self.hasListeners = NO;
}

- (void)emitEventWithType:(NSString *)type body:(NSDictionary *)body {
  if (!self.hasListeners) return;
  NSMutableDictionary *payload = body != nil ? [body mutableCopy] : [NSMutableDictionary dictionary];
  payload[@"type"] = type ?: @"state";
  dispatch_async(dispatch_get_main_queue(), ^{
    [self sendEventWithName:@"flac-player-event" body:payload];
  });
}

- (void)emitState:(NSString *)state position:(NSNumber *)position duration:(NSNumber *)duration {
  self.currentState = state ?: @"idle";
  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  payload[@"state"] = self.currentState;
  payload[@"position"] = position ?: @(self.player != nil ? self.player.currentTime : 0);
  payload[@"duration"] = duration ?: @(self.player != nil ? self.player.duration : 0);
  [self emitEventWithType:@"state" body:payload];
}

- (void)emitErrorMessage:(NSString *)message {
  [self emitEventWithType:@"error" body:@{
    @"message": message ?: @"Unknown flac player error",
    @"state": self.currentState ?: @"idle",
    @"position": @(self.player != nil ? self.player.currentTime : 0),
    @"duration": @(self.player != nil ? self.player.duration : 0),
  }];
}

- (BOOL)prepareAudioSession:(NSError **)error {
  AVAudioSession *session = [AVAudioSession sharedInstance];
  if (@available(iOS 13.0, *)) {
    if (![session setCategory:AVAudioSessionCategoryPlayback
                      mode:AVAudioSessionModeDefault
        routeSharingPolicy:AVAudioSessionRouteSharingPolicyLongFormAudio
                   options:0
                     error:error]) return NO;
  } else {
    if (![session setCategory:AVAudioSessionCategoryPlayback error:error]) return NO;
  }
  if (![session setActive:YES error:error]) return NO;
  return YES;
}

- (BOOL)loadPlayerWithPath:(NSString *)filePath error:(NSError **)error {
  if (self.player != nil && [self.currentPath isEqualToString:filePath]) return YES;

  if (self.player != nil) {
    [self.player stop];
    self.player.delegate = nil;
    self.player = nil;
  }

  NSURL *fileURL = [NSURL fileURLWithPath:filePath];
  AVAudioPlayer *player = [[AVAudioPlayer alloc] initWithContentsOfURL:fileURL error:error];
  if (player == nil) return NO;

  player.delegate = self;
  player.enableRate = YES;
  [player prepareToPlay];
  self.player = player;
  self.currentPath = filePath;
  return YES;
}

- (void)teardownPlayer {
  if (self.player != nil) {
    [self.player stop];
    self.player.delegate = nil;
    self.player = nil;
  }
  self.currentPath = nil;
  self.currentState = @"idle";
  self.manualPause = NO;
  self.interruptedBySystem = NO;
}

- (void)handleAudioSessionInterruption:(NSNotification *)notification {
  NSDictionary *userInfo = notification.userInfo;
  if (userInfo == nil || self.player == nil) return;

  AVAudioSessionInterruptionType type = (AVAudioSessionInterruptionType)[userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
  switch (type) {
    case AVAudioSessionInterruptionTypeBegan: {
      BOOL shouldHandle = self.player.isPlaying || [self.currentState isEqualToString:@"playing"];
      if (!shouldHandle) return;
      self.interruptedBySystem = !self.manualPause;
      [self.player pause];
      if (!self.manualPause) [self emitState:@"paused" position:nil duration:nil];
      break;
    }
    case AVAudioSessionInterruptionTypeEnded: {
      BOOL shouldResume = ([userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue] & AVAudioSessionInterruptionOptionShouldResume) != 0;
      if (!self.interruptedBySystem || self.manualPause || !shouldResume) {
        self.interruptedBySystem = NO;
        return;
      }

      self.interruptedBySystem = NO;
      NSError *sessionError = nil;
      if (![self prepareAudioSession:&sessionError]) {
        [self emitErrorMessage:sessionError.localizedDescription ?: @"Failed to reactivate audio session"];
        return;
      }
      if ([self.player play]) {
        [self emitState:@"playing" position:nil duration:nil];
      } else {
        [self emitErrorMessage:@"Failed to resume flac playback after interruption"];
      }
      break;
    }
    default:
      break;
  }
}

RCT_REMAP_METHOD(playFile, playFile:(NSString *)filePath position:(nonnull NSNumber *)position volume:(nonnull NSNumber *)volume rate:(nonnull NSNumber *)rate autoplay:(nonnull NSNumber *)autoplay resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![filePath isKindOfClass:[NSString class]] || filePath.length == 0) {
      NSError *error = LXError(@"flac_player_path", @"Missing flac player file path");
      reject(@"flac_player_path", error.localizedDescription, error);
      return;
    }

    [self emitState:@"loading" position:position duration:nil];

    NSError *error = nil;
    if (![self prepareAudioSession:&error] || ![self loadPlayerWithPath:filePath error:&error]) {
      [self emitErrorMessage:error.localizedDescription ?: @"Failed to initialize flac player"];
      reject(@"flac_player_load", error.localizedDescription ?: @"Failed to initialize flac player", error);
      return;
    }

    self.player.volume = [volume floatValue];
    self.player.rate = MAX([rate floatValue], 0.5f);
    self.player.currentTime = LXClampDouble([position doubleValue], 0, self.player.duration);
    BOOL shouldAutoplay = autoplay == nil ? YES : [autoplay boolValue];
    self.manualPause = !shouldAutoplay;
    self.interruptedBySystem = NO;

    if (shouldAutoplay) {
      if (![self.player play]) {
        NSError *playError = LXError(@"flac_player_play", @"Failed to start flac playback");
        [self emitErrorMessage:playError.localizedDescription];
        reject(@"flac_player_play", playError.localizedDescription, playError);
        return;
      }
    }

    NSNumber *currentPosition = @(self.player.currentTime);
    NSNumber *currentDuration = @(self.player.duration);
    [self emitState:(shouldAutoplay ? @"playing" : @"paused") position:currentPosition duration:currentDuration];
    resolve(@{
      @"position": currentPosition,
      @"duration": currentDuration,
    });
  });
}

RCT_REMAP_METHOD(resume, resumeWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.player == nil) {
      NSError *error = LXError(@"flac_player_resume", @"No flac player instance to resume");
      reject(@"flac_player_resume", error.localizedDescription, error);
      return;
    }

    NSError *sessionError = nil;
    if (![self prepareAudioSession:&sessionError]) {
      [self emitErrorMessage:sessionError.localizedDescription ?: @"Failed to activate audio session"];
      reject(@"flac_player_resume", sessionError.localizedDescription ?: @"Failed to activate audio session", sessionError);
      return;
    }

    if (![self.player play]) {
      NSError *error = LXError(@"flac_player_resume", @"Failed to resume flac playback");
      [self emitErrorMessage:error.localizedDescription];
      reject(@"flac_player_resume", error.localizedDescription, error);
      return;
    }

    self.manualPause = NO;
    self.interruptedBySystem = NO;
    [self emitState:@"playing" position:nil duration:nil];
    resolve(nil);
  });
}

RCT_REMAP_METHOD(pause, pauseWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    self.manualPause = YES;
    self.interruptedBySystem = NO;
    if (self.player != nil) [self.player pause];
    [self emitState:@"paused" position:nil duration:nil];
    resolve(nil);
  });
}

RCT_REMAP_METHOD(stop, stopWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    self.manualPause = YES;
    self.interruptedBySystem = NO;
    if (self.player != nil) {
      [self.player stop];
      self.player.currentTime = 0;
    }
    [self emitState:@"stopped" position:@0 duration:nil];
    resolve(nil);
  });
}

RCT_REMAP_METHOD(reset, resetWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [self teardownPlayer];
    [self emitState:@"idle" position:@0 duration:@0];
    resolve(nil);
  });
}

RCT_REMAP_METHOD(seekTo, seekTo:(nonnull NSNumber *)position resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.player == nil) {
      NSError *error = LXError(@"flac_player_seek", @"No flac player instance to seek");
      reject(@"flac_player_seek", error.localizedDescription, error);
      return;
    }

    self.player.currentTime = LXClampDouble([position doubleValue], 0, self.player.duration);
    resolve(@(self.player.currentTime));
  });
}

RCT_REMAP_METHOD(setVolume, setVolume:(nonnull NSNumber *)volume resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.player != nil) self.player.volume = [volume floatValue];
    resolve(nil);
  });
}

RCT_REMAP_METHOD(setRate, setRate:(nonnull NSNumber *)rate resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.player != nil) {
      self.player.enableRate = YES;
      self.player.rate = MAX([rate floatValue], 0.5f);
      if (self.player.isPlaying) [self.player play];
    }
    resolve(nil);
  });
}

RCT_REMAP_METHOD(getPosition, getPositionWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    resolve(@(self.player != nil ? self.player.currentTime : 0));
  });
}

RCT_REMAP_METHOD(getDuration, getDurationWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    resolve(@(self.player != nil ? self.player.duration : 0));
  });
}

RCT_REMAP_METHOD(getState, getStateWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.player == nil) {
      resolve(@"idle");
      return;
    }
    if (self.player.isPlaying) {
      resolve(@"playing");
      return;
    }
    resolve(self.currentState ?: @"paused");
  });
}

- (void)audioPlayerDidFinishPlaying:(AVAudioPlayer *)player successfully:(BOOL)flag {
  if (player != self.player) return;
  self.manualPause = NO;
  self.interruptedBySystem = NO;
  [self emitEventWithType:@"ended" body:@{
    @"state": @"stopped",
    @"position": @(player.duration),
    @"duration": @(player.duration),
    @"success": @(flag),
  }];
}

- (void)audioPlayerDecodeErrorDidOccur:(AVAudioPlayer *)player error:(NSError *)error {
  if (player != self.player) return;
  self.interruptedBySystem = NO;
  self.currentState = @"paused";
  [self emitErrorMessage:error.localizedDescription ?: @"Flac decode failed"];
}

@end

@interface StreamingFlacPlayerModule : RCTEventEmitter<RCTBridgeModule, NSURLSessionDataDelegate>
@property (nonatomic, strong) NSURLSession *session;
@property (nonatomic, strong) NSCondition *streamCondition;
@property (nonatomic, strong) dispatch_queue_t decoderQueue;
@property (nonatomic, strong) dispatch_queue_t renderQueue;
@property (nonatomic, strong) AVAudioEngine *engine;
@property (nonatomic, strong) AVAudioPlayerNode *playerNode;
@property (nonatomic, strong) AVAudioUnitTimePitch *timePitchNode;
@property (nonatomic, strong) AVAudioFormat *outputFormat;
@property (nonatomic, copy) NSDictionary<NSString *, NSString *> *requestHeaders;
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, NSData *> *rangeChunkCache;
@property (nonatomic, strong) NSData *fullStreamData;
@property (nonatomic, copy) NSString *currentState;
@property (nonatomic, copy) NSString *currentURL;
@property (nonatomic, strong) NSError *streamError;
@property (nonatomic, assign) BOOL hasListeners;
@property (nonatomic, assign) BOOL downloadCompleted;
@property (nonatomic, assign) BOOL stopRequested;
@property (nonatomic, assign) BOOL playbackStarted;
@property (nonatomic, assign) BOOL manualPause;
@property (nonatomic, assign) BOOL interruptedBySystem;
@property (nonatomic, assign) double duration;
@property (nonatomic, assign) double sampleRate;
@property (nonatomic, assign) NSUInteger channels;
@property (nonatomic, assign) NSUInteger bitsPerSample;
@property (nonatomic, assign) double startThresholdSeconds;
@property (nonatomic, assign) double normalStartThresholdSeconds;
@property (nonatomic, assign) double seekStartThresholdSeconds;
@property (nonatomic, assign) double maxBufferSeconds;
@property (nonatomic, assign) double pausedBufferSeconds;
@property (nonatomic, assign) double lastKnownPosition;
@property (nonatomic, assign) double pendingSeekPosition;
@property (nonatomic, assign) float currentVolume;
@property (nonatomic, assign) float currentRate;
@property (nonatomic, assign) int64_t queuedFrames;
@property (nonatomic, assign) int64_t completedFrames;
@property (nonatomic, assign) int64_t seekTargetFrame;
@property (nonatomic, assign) int64_t playbackGeneration;
@property (nonatomic, assign) int64_t playbackAnchorFrame;
@property (nonatomic, assign) int64_t currentByteOffset;
@property (nonatomic, assign) int64_t streamLengthBytes;
@property (nonatomic, assign) BOOL seekRequested;
@property (nonatomic, assign) BOOL seekInProgress;
@property (nonatomic, assign) BOOL fastForwardSeekActive;
@property (nonatomic, assign) NSUInteger rangeChunkSize;
#if LX_HAS_LIBFLAC
@property (nonatomic, assign) FLAC__StreamDecoder *decoder;
#endif
@end

#if LX_HAS_LIBFLAC
static FLAC__StreamDecoderReadStatus LXStreamingFlacReadCallback(const FLAC__StreamDecoder *decoder, FLAC__byte buffer[], size_t *bytes, void *client_data);
static FLAC__StreamDecoderSeekStatus LXStreamingFlacSeekCallback(const FLAC__StreamDecoder *decoder, FLAC__uint64 absolute_byte_offset, void *client_data);
static FLAC__StreamDecoderTellStatus LXStreamingFlacTellCallback(const FLAC__StreamDecoder *decoder, FLAC__uint64 *absolute_byte_offset, void *client_data);
static FLAC__StreamDecoderLengthStatus LXStreamingFlacLengthCallback(const FLAC__StreamDecoder *decoder, FLAC__uint64 *stream_length, void *client_data);
static FLAC__bool LXStreamingFlacEofCallback(const FLAC__StreamDecoder *decoder, void *client_data);
static FLAC__StreamDecoderWriteStatus LXStreamingFlacWriteCallback(const FLAC__StreamDecoder *decoder, const FLAC__Frame *frame, const FLAC__int32 * const buffer[], void *client_data);
static void LXStreamingFlacMetadataCallback(const FLAC__StreamDecoder *decoder, const FLAC__StreamMetadata *metadata, void *client_data);
static void LXStreamingFlacErrorCallback(const FLAC__StreamDecoder *decoder, FLAC__StreamDecoderErrorStatus status, void *client_data);
#endif

@implementation StreamingFlacPlayerModule

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _streamCondition = [[NSCondition alloc] init];
    _decoderQueue = dispatch_queue_create("cn.toside.music.mobile.streamingflac.decoder", DISPATCH_QUEUE_SERIAL);
    _renderQueue = dispatch_queue_create("cn.toside.music.mobile.streamingflac.render", DISPATCH_QUEUE_SERIAL);
    _currentState = @"idle";
    _normalStartThresholdSeconds = 3.0;
    _seekStartThresholdSeconds = 0.25;
    _startThresholdSeconds = _normalStartThresholdSeconds;
    _maxBufferSeconds = 8.0;
    _pausedBufferSeconds = 2.0;
    _rangeChunkSize = 262144;
    _currentVolume = 1.0f;
    _currentRate = 1.0f;
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(handleAudioSessionInterruption:)
                                                 name:AVAudioSessionInterruptionNotification
                                               object:[AVAudioSession sharedInstance]];
  }
  return self;
}

- (void)dealloc {
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (NSArray<NSString *> *)supportedEvents {
  return @[ @"streaming-flac-event" ];
}

- (void)startObserving {
  self.hasListeners = YES;
}

- (void)stopObserving {
  self.hasListeners = NO;
}

- (void)emitEventWithType:(NSString *)type body:(NSDictionary *)body {
  if (!self.hasListeners) return;
  NSMutableDictionary *payload = body != nil ? [body mutableCopy] : [NSMutableDictionary dictionary];
  payload[@"type"] = type ?: @"state";
  dispatch_async(dispatch_get_main_queue(), ^{
    [self sendEventWithName:@"streaming-flac-event" body:payload];
  });
}

- (void)emitState:(NSString *)state position:(NSNumber *)position duration:(NSNumber *)duration {
  self.currentState = state ?: @"idle";
  [self emitEventWithType:@"state" body:@{
    @"state": self.currentState,
    @"position": position ?: @(self.lastKnownPosition),
    @"duration": duration ?: @(self.duration),
  }];
}

- (void)emitErrorMessage:(NSString *)message {
  [self emitEventWithType:@"error" body:@{
    @"message": message ?: @"Unknown streaming flac error",
    @"state": self.currentState ?: @"idle",
    @"position": @(self.lastKnownPosition),
    @"duration": @(self.duration),
  }];
}

- (BOOL)prepareAudioSession:(NSError **)error {
  AVAudioSession *session = [AVAudioSession sharedInstance];
  if (@available(iOS 13.0, *)) {
    if (![session setCategory:AVAudioSessionCategoryPlayback
                      mode:AVAudioSessionModeDefault
        routeSharingPolicy:AVAudioSessionRouteSharingPolicyLongFormAudio
                   options:0
                     error:error]) return NO;
  } else {
    if (![session setCategory:AVAudioSessionCategoryPlayback error:error]) return NO;
  }
  if (![session setActive:YES error:error]) return NO;
  return YES;
}

- (void)resetStreamingState {
  self.requestHeaders = @{};
  self.rangeChunkCache = [NSMutableDictionary dictionary];
  self.fullStreamData = nil;
  self.streamError = nil;
  self.downloadCompleted = NO;
  self.stopRequested = NO;
  self.playbackStarted = NO;
  self.manualPause = NO;
  self.interruptedBySystem = NO;
  self.duration = 0;
  self.sampleRate = 0;
  self.channels = 0;
  self.bitsPerSample = 0;
  self.lastKnownPosition = 0;
  self.pendingSeekPosition = 0;
  self.queuedFrames = 0;
  self.completedFrames = 0;
  self.seekTargetFrame = 0;
  self.seekRequested = NO;
  self.seekInProgress = NO;
  self.fastForwardSeekActive = NO;
  self.playbackGeneration += 1;
  self.playbackAnchorFrame = 0;
  self.currentByteOffset = 0;
  self.streamLengthBytes = 0;
  self.startThresholdSeconds = self.normalStartThresholdSeconds;
  self.outputFormat = nil;
}

- (void)handleAudioSessionInterruption:(NSNotification *)notification {
  NSDictionary *userInfo = notification.userInfo;
  if (userInfo == nil || self.currentURL.length == 0) return;

  AVAudioSessionInterruptionType type = (AVAudioSessionInterruptionType)[userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
  switch (type) {
    case AVAudioSessionInterruptionTypeBegan: {
      __block BOOL shouldEmitPause = NO;
      dispatch_sync(self.renderQueue, ^{
        BOOL shouldHandle = self.playerNode != nil && (self.playerNode.isPlaying || self.playbackStarted || [self.currentState isEqualToString:@"buffering"]);
        if (!shouldHandle || self.manualPause) return;
        self.lastKnownPosition = [self currentPlaybackPositionLocked];
        [self.playerNode pause];
        self.playbackStarted = NO;
        shouldEmitPause = YES;
      });
      if (!shouldEmitPause) return;
      self.interruptedBySystem = YES;
      self.currentState = @"paused";
      [self emitState:@"paused" position:@(self.lastKnownPosition) duration:@(self.duration)];
      break;
    }
    case AVAudioSessionInterruptionTypeEnded: {
      BOOL shouldResume = ([userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue] & AVAudioSessionInterruptionOptionShouldResume) != 0;
      if (!self.interruptedBySystem || self.manualPause || !shouldResume) {
        self.interruptedBySystem = NO;
        return;
      }

      self.interruptedBySystem = NO;
      NSError *sessionError = nil;
      if (![self prepareAudioSession:&sessionError]) {
        [self emitErrorMessage:sessionError.localizedDescription ?: @"Failed to reactivate audio session"];
        return;
      }

      __block NSError *engineError = nil;
      __block BOOL didResumePlaying = NO;
      __block BOOL shouldEmitBuffering = NO;
      dispatch_sync(self.renderQueue, ^{
        if (self.engine != nil && !self.engine.isRunning) {
          if (![self.engine startAndReturnError:&engineError]) return;
        }
        self.manualPause = NO;
        [self maybeStartPlaybackLocked];
        didResumePlaying = self.playbackStarted;
        if (!didResumePlaying) {
          self.currentState = @"buffering";
          shouldEmitBuffering = YES;
        }
      });
      if (engineError != nil) {
        [self emitErrorMessage:engineError.localizedDescription ?: @"Failed to restart audio engine after interruption"];
        return;
      }
      if (shouldEmitBuffering) {
        [self emitState:@"buffering" position:@(self.lastKnownPosition) duration:@(self.duration)];
      }
      break;
    }
    default:
      break;
  }
}

- (void)cleanupAudioGraphLocked {
  if (self.playerNode != nil) {
    [self.playerNode stop];
  }
  if (self.engine != nil) {
    [self.engine stop];
    if (self.playerNode != nil) [self.engine detachNode:self.playerNode];
    if (self.timePitchNode != nil) [self.engine detachNode:self.timePitchNode];
  }
  self.playerNode = nil;
  self.timePitchNode = nil;
  self.engine = nil;
  self.outputFormat = nil;
}

- (double)currentPlaybackPositionLocked {
  if (self.sampleRate <= 0) return self.lastKnownPosition;
  if (self.playerNode != nil && self.playerNode.isPlaying) {
    AVAudioTime *renderTime = self.playerNode.lastRenderTime;
    if (renderTime != nil) {
      AVAudioTime *playerTime = [self.playerNode playerTimeForNodeTime:renderTime];
      if (playerTime != nil) {
        self.lastKnownPosition = MAX(0, (double)(self.playbackAnchorFrame + playerTime.sampleTime) / self.sampleRate);
      }
    }
  } else {
    self.lastKnownPosition = MAX(self.lastKnownPosition, self.sampleRate > 0 ? (double)self.completedFrames / self.sampleRate : self.lastKnownPosition);
  }
  return self.lastKnownPosition;
}

- (void)configureAudioGraphWithSampleRate:(double)sampleRate channels:(NSUInteger)channels bitsPerSample:(NSUInteger)bitsPerSample {
  dispatch_sync(self.renderQueue, ^{
    if (self.engine != nil) return;

    self.outputFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32
                                                         sampleRate:sampleRate
                                                           channels:(AVAudioChannelCount)channels
                                                        interleaved:NO];
    self.engine = [[AVAudioEngine alloc] init];
    self.playerNode = [[AVAudioPlayerNode alloc] init];
    self.timePitchNode = [[AVAudioUnitTimePitch alloc] init];
    self.timePitchNode.rate = self.currentRate;
    [self.engine attachNode:self.playerNode];
    [self.engine attachNode:self.timePitchNode];
    [self.engine connect:self.playerNode to:self.timePitchNode format:self.outputFormat];
    [self.engine connect:self.timePitchNode to:self.engine.mainMixerNode format:self.outputFormat];
    self.playerNode.volume = self.currentVolume;
    [self.engine prepare];

    NSError *error = nil;
    if (![self.engine startAndReturnError:&error]) {
      self.streamError = error ?: LXError(@"streaming_flac_engine", @"Failed to start AVAudioEngine");
    }
  });

  if (self.streamError != nil) {
    [self emitErrorMessage:self.streamError.localizedDescription ?: @"Failed to start AVAudioEngine"];
  }
}

- (void)maybeStartPlaybackLocked {
  if (self.manualPause || self.playerNode == nil || self.sampleRate <= 0) return;
  double queuedSeconds = (double)self.queuedFrames / self.sampleRate;
  if (!self.playbackStarted && (queuedSeconds >= self.startThresholdSeconds || (self.downloadCompleted && self.queuedFrames > 0))) {
    [self.playerNode play];
    self.playbackStarted = YES;
    self.fastForwardSeekActive = NO;
    self.startThresholdSeconds = self.normalStartThresholdSeconds;
    [self emitState:@"playing" position:@(self.lastKnownPosition) duration:@(self.duration)];
  }
}

- (NSString *)headerValueForName:(NSString *)headerName response:(NSHTTPURLResponse *)response {
  for (id key in response.allHeaderFields) {
    if (![key isKindOfClass:[NSString class]]) continue;
    if (![(NSString *)key caseInsensitiveCompare:headerName]) {
      id value = response.allHeaderFields[key];
      return [value isKindOfClass:[NSString class]] ? value : [value description];
    }
  }
  return nil;
}

- (BOOL)parseContentRange:(NSString *)contentRange rangeStart:(int64_t *)rangeStart rangeEnd:(int64_t *)rangeEnd totalLength:(int64_t *)totalLength {
  if (contentRange.length == 0) return NO;
  NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"bytes\\s+(\\d+)-(\\d+)/(\\d+|\\*)" options:0 error:nil];
  NSTextCheckingResult *match = [regex firstMatchInString:contentRange options:0 range:NSMakeRange(0, contentRange.length)];
  if (match.numberOfRanges != 4) return NO;

  NSString *startString = [contentRange substringWithRange:[match rangeAtIndex:1]];
  NSString *endString = [contentRange substringWithRange:[match rangeAtIndex:2]];
  NSString *totalString = [contentRange substringWithRange:[match rangeAtIndex:3]];

  if (rangeStart != NULL) *rangeStart = startString.longLongValue;
  if (rangeEnd != NULL) *rangeEnd = endString.longLongValue;
  if (totalLength != NULL) *totalLength = [totalString isEqualToString:@"*"] ? -1 : totalString.longLongValue;
  return YES;
}

- (NSData *)performSynchronousRequest:(NSURLRequest *)request response:(NSHTTPURLResponse **)response error:(NSError **)error {
  if (self.session == nil) {
    NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration ephemeralSessionConfiguration];
    configuration.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
    configuration.timeoutIntervalForRequest = 30;
    configuration.timeoutIntervalForResource = 60;
    self.session = [NSURLSession sessionWithConfiguration:configuration];
  }

  __block NSData *resultData = nil;
  __block NSHTTPURLResponse *resultResponse = nil;
  __block NSError *resultError = nil;
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  NSURLSessionDataTask *dataTask = [self.session dataTaskWithRequest:request completionHandler:^(NSData *data, NSURLResponse *rawResponse, NSError *requestError) {
    resultData = data;
    resultResponse = [rawResponse isKindOfClass:[NSHTTPURLResponse class]] ? (NSHTTPURLResponse *)rawResponse : nil;
    resultError = requestError;
    dispatch_semaphore_signal(semaphore);
  }];
  [dataTask resume];

  while (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.1 * NSEC_PER_SEC))) != 0) {
    if (!self.stopRequested) continue;
    [dataTask cancel];
    if (error != NULL) *error = LXError(@"streaming_flac_http", @"Streaming FLAC request was cancelled");
    return nil;
  }

  if (response != NULL) *response = resultResponse;
  if (resultError != nil && error != NULL) *error = resultError;
  return resultData;
}

- (void)trimRangeChunkCacheAroundByteOffset:(int64_t)byteOffset {
  if (self.fullStreamData != nil || self.rangeChunkCache.count <= 18 || self.rangeChunkSize == 0) return;

  long long centerIndex = byteOffset / (long long)self.rangeChunkSize;
  NSMutableArray<NSNumber *> *keysToRemove = [NSMutableArray array];
  for (NSNumber *key in self.rangeChunkCache.allKeys) {
    long long chunkIndex = key.longLongValue;
    if (llabs(chunkIndex - centerIndex) > 8) [keysToRemove addObject:key];
  }
  [self.rangeChunkCache removeObjectsForKeys:keysToRemove];
}

- (BOOL)fetchChunkAtIndex:(NSUInteger)chunkIndex error:(NSError **)error {
  if (self.fullStreamData != nil) return YES;

  NSNumber *cacheKey = @(chunkIndex);
  if (self.rangeChunkCache[cacheKey] != nil) return YES;

  int64_t start = (int64_t)chunkIndex * (int64_t)self.rangeChunkSize;
  if (self.streamLengthBytes > 0 && start >= self.streamLengthBytes) return YES;

  int64_t end = start + (int64_t)self.rangeChunkSize - 1;
  if (self.streamLengthBytes > 0) end = MIN(end, self.streamLengthBytes - 1);

  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[NSURL URLWithString:self.currentURL]];
  for (NSString *key in self.requestHeaders) {
    NSString *value = self.requestHeaders[key];
    if (value.length) [request setValue:value forHTTPHeaderField:key];
  }
  [request setValue:[NSString stringWithFormat:@"bytes=%lld-%lld", start, end] forHTTPHeaderField:@"Range"];

  NSHTTPURLResponse *response = nil;
  NSData *data = [self performSynchronousRequest:request response:&response error:error];
  if (data == nil || response == nil) return NO;

  NSInteger statusCode = response.statusCode;
  if (statusCode == 206) {
    int64_t rangeStart = 0;
    int64_t rangeEnd = 0;
    int64_t totalLength = -1;
    NSString *contentRange = [self headerValueForName:@"Content-Range" response:response];
    if (![self parseContentRange:contentRange rangeStart:&rangeStart rangeEnd:&rangeEnd totalLength:&totalLength] || rangeStart != start || totalLength <= 0) {
      if (error != NULL) *error = LXError(@"streaming_flac_range", @"Invalid HTTP range response");
      return NO;
    }
    self.streamLengthBytes = totalLength;
    self.rangeChunkCache[cacheKey] = data;
    [self trimRangeChunkCacheAroundByteOffset:start];
    return YES;
  }

  if (statusCode >= 200 && statusCode < 300 && start == 0) {
    self.fullStreamData = data;
    self.streamLengthBytes = response.expectedContentLength > 0 ? response.expectedContentLength : (int64_t)data.length;
    self.downloadCompleted = YES;
    return YES;
  }

  if (error != NULL) {
    *error = LXError(@"streaming_flac_range", [NSString stringWithFormat:@"HTTP range request failed: %ld", (long)statusCode]);
  }
  return NO;
}

- (BOOL)prepareRangeSourceIfNeeded:(NSError **)error {
  if (self.fullStreamData != nil || self.streamLengthBytes > 0 || self.rangeChunkCache[@0] != nil) return YES;
  return [self fetchChunkAtIndex:0 error:error];
}

- (void)waitForBufferCapacityIfNeeded {
  while (!self.stopRequested && !self.seekRequested) {
    __block BOOL shouldWait = NO;
    dispatch_sync(self.renderQueue, ^{
      if (self.playerNode == nil || self.sampleRate <= 0) return;
      double queuedSeconds = (double)self.queuedFrames / self.sampleRate;
      double limit = self.manualPause ? self.pausedBufferSeconds : self.maxBufferSeconds;
      shouldWait = limit > 0 && queuedSeconds >= limit;
    });
    if (!shouldWait) break;
    [NSThread sleepForTimeInterval:0.03];
  }
}

#if LX_HAS_LIBFLAC
- (void)applyPendingSeekIfNeeded {
  if (!self.seekRequested || self.sampleRate <= 0 || self.decoder == NULL) return;

  double clampedPosition = self.duration > 0
    ? LXClampDouble(self.pendingSeekPosition, 0, self.duration)
    : MAX(self.pendingSeekPosition, 0);
  FLAC__uint64 targetSample = (FLAC__uint64)llround(clampedPosition * self.sampleRate);

  self.seekRequested = NO;
  self.seekTargetFrame = (int64_t)targetSample;
  self.seekInProgress = YES;
  self.fastForwardSeekActive = NO;
  self.startThresholdSeconds = self.seekStartThresholdSeconds;

  dispatch_sync(self.renderQueue, ^{
    self.playbackGeneration += 1;
    if (self.playerNode != nil) [self.playerNode stop];
    self.queuedFrames = 0;
    self.completedFrames = self.seekTargetFrame;
    self.playbackAnchorFrame = self.seekTargetFrame;
    self.lastKnownPosition = clampedPosition;
    self.playbackStarted = NO;
  });

  if (!FLAC__stream_decoder_seek_absolute(self.decoder, targetSample)) {
    self.seekInProgress = NO;
    self.streamError = LXError(@"streaming_flac_seek", @"Failed to seek FLAC stream");
    [self emitErrorMessage:self.streamError.localizedDescription];
    return;
  }
}
#endif

- (void)schedulePCMBufferWithFrame:(const FLAC__Frame *)frame buffer:(const FLAC__int32 * const[])decodedBuffer startOffset:(NSUInteger)startOffset {
  if (self.outputFormat == nil || self.streamError != nil) return;

  const NSUInteger blockSize = frame->header.blocksize;
  if (startOffset >= blockSize) return;

  const NSUInteger playableFrames = blockSize - startOffset;
  AVAudioPCMBuffer *pcmBuffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:self.outputFormat frameCapacity:(AVAudioFrameCount)playableFrames];
  if (pcmBuffer == nil) {
    self.streamError = LXError(@"streaming_flac_buffer", @"Failed to allocate PCM buffer");
    return;
  }

  pcmBuffer.frameLength = (AVAudioFrameCount)playableFrames;
  float *const *channels = pcmBuffer.floatChannelData;
  double scale = self.bitsPerSample > 1 ? ldexp(1.0, (int)self.bitsPerSample - 1) : 1.0;
  if (scale <= 0) scale = 1.0;
  for (NSUInteger channel = 0; channel < self.channels; channel++) {
    for (NSUInteger sample = 0; sample < playableFrames; sample++) {
      FLAC__int32 value = decodedBuffer[channel][sample + startOffset];
      double normalized = LXClampDouble((double)value / scale, -1.0, 1.0);
      channels[channel][sample] = (float)normalized;
    }
  }

  const int64_t queuedFrameCount = (int64_t)playableFrames;
  __block int64_t generation = 0;
  dispatch_sync(self.renderQueue, ^{
    if (self.playerNode == nil || self.stopRequested) return;

    generation = self.playbackGeneration;
    self.queuedFrames += queuedFrameCount;
    [self.playerNode scheduleBuffer:pcmBuffer completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack completionHandler:^(AVAudioPlayerNodeCompletionCallbackType callbackType) {
      dispatch_async(self.renderQueue, ^{
        if (generation != self.playbackGeneration) return;
        self.completedFrames += queuedFrameCount;
        self.queuedFrames = MAX(0, self.queuedFrames - queuedFrameCount);
        self.lastKnownPosition = self.sampleRate > 0 ? (double)self.completedFrames / self.sampleRate : self.lastKnownPosition;
        if (self.downloadCompleted && self.queuedFrames == 0 && !self.stopRequested) {
          self.playbackStarted = NO;
          [self emitEventWithType:@"ended" body:@{
            @"state": @"stopped",
            @"position": @(self.lastKnownPosition),
            @"duration": @(self.duration),
          }];
        } else if (!self.downloadCompleted && self.playbackStarted && self.sampleRate > 0 && ((double)self.queuedFrames / self.sampleRate) < 0.35) {
          [self.playerNode pause];
          self.playbackStarted = NO;
          [self emitState:@"buffering" position:@(self.lastKnownPosition) duration:@(self.duration)];
        }
      });
    }];
    [self maybeStartPlaybackLocked];
  });
}

- (void)startDecoderLoop {
#if !LX_HAS_LIBFLAC
  self.streamError = LXError(@"streaming_flac_decoder", @"libFLAC is not available");
  [self emitErrorMessage:self.streamError.localizedDescription];
#else
  dispatch_async(self.decoderQueue, ^{
    NSError *sourceError = nil;
    if (![self prepareRangeSourceIfNeeded:&sourceError]) {
      self.streamError = sourceError ?: LXError(@"streaming_flac_http", @"Failed to prepare FLAC range source");
      [self emitErrorMessage:self.streamError.localizedDescription];
      return;
    }

    self.decoder = FLAC__stream_decoder_new();
    if (self.decoder == NULL) {
      self.streamError = LXError(@"streaming_flac_decoder", @"Failed to create FLAC decoder");
      [self emitErrorMessage:self.streamError.localizedDescription];
      return;
    }

    FLAC__stream_decoder_set_md5_checking(self.decoder, false);
    FLAC__StreamDecoderInitStatus initStatus = FLAC__stream_decoder_init_stream(
      self.decoder,
      LXStreamingFlacReadCallback,
      LXStreamingFlacSeekCallback,
      LXStreamingFlacTellCallback,
      LXStreamingFlacLengthCallback,
      LXStreamingFlacEofCallback,
      LXStreamingFlacWriteCallback,
      LXStreamingFlacMetadataCallback,
      LXStreamingFlacErrorCallback,
      (__bridge void *)self
    );
    if (initStatus != FLAC__STREAM_DECODER_INIT_STATUS_OK) {
      self.streamError = LXError(@"streaming_flac_init", [NSString stringWithFormat:@"FLAC decoder init failed: %d", initStatus]);
      [self emitErrorMessage:self.streamError.localizedDescription];
      FLAC__stream_decoder_delete(self.decoder);
      self.decoder = NULL;
      return;
    }

    while (!self.stopRequested) {
      [self applyPendingSeekIfNeeded];
      if (!FLAC__stream_decoder_process_single(self.decoder)) {
        if (self.streamError == nil) {
          self.streamError = LXError(@"streaming_flac_decode", @"FLAC decoder failed during processing");
          [self emitErrorMessage:self.streamError.localizedDescription];
        }
        break;
      }
      [self waitForBufferCapacityIfNeeded];
      if (FLAC__stream_decoder_get_state(self.decoder) == FLAC__STREAM_DECODER_END_OF_STREAM) {
        self.downloadCompleted = YES;
        break;
      }
    }

    FLAC__stream_decoder_finish(self.decoder);
    FLAC__stream_decoder_delete(self.decoder);
    self.decoder = NULL;

    dispatch_async(self.renderQueue, ^{
      if (self.downloadCompleted && self.queuedFrames == 0 && !self.stopRequested) {
        [self emitEventWithType:@"ended" body:@{
          @"state": @"stopped",
          @"position": @(self.lastKnownPosition),
          @"duration": @(self.duration),
        }];
      }
    });
  });
#endif
}

- (void)stopStreamingInternal:(BOOL)resetAudio {
  self.stopRequested = YES;
  [self.streamCondition lock];
  [self.streamCondition broadcast];
  [self.streamCondition unlock];
  [self.session invalidateAndCancel];
  self.session = nil;
  self.downloadCompleted = YES;
  if (resetAudio) {
    dispatch_sync(self.renderQueue, ^{
      self.lastKnownPosition = [self currentPlaybackPositionLocked];
      self.playbackGeneration += 1;
      [self cleanupAudioGraphLocked];
    });
  }
}

- (void)restartDecoderLoopForQuickSeek {
  self.stopRequested = YES;
  [self.streamCondition lock];
  [self.streamCondition broadcast];
  [self.streamCondition unlock];
  dispatch_sync(self.decoderQueue, ^{});
  self.stopRequested = NO;
  self.streamError = nil;
  self.currentByteOffset = 0;
  self.downloadCompleted = self.fullStreamData != nil;
  [self startDecoderLoop];
}

RCT_REMAP_METHOD(openStream, openStream:(NSString *)urlString headers:(NSDictionary *)headers volume:(nonnull NSNumber *)volume rate:(nonnull NSNumber *)rate autoplay:(nonnull NSNumber *)autoplay resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (![urlString isKindOfClass:[NSString class]] || urlString.length == 0) {
      NSError *error = LXError(@"streaming_flac_url", @"Missing FLAC stream url");
      reject(@"streaming_flac_url", error.localizedDescription, error);
      return;
    }

    NSError *sessionError = nil;
    if (![self prepareAudioSession:&sessionError]) {
      [self emitErrorMessage:sessionError.localizedDescription ?: @"Failed to activate audio session"];
      reject(@"streaming_flac_session", sessionError.localizedDescription ?: @"Failed to activate audio session", sessionError);
      return;
    }

    [self stopStreamingInternal:YES];
    [self resetStreamingState];
    self.currentURL = urlString;
    self.currentState = @"loading";
    self.currentVolume = [volume floatValue];
    self.currentRate = MAX([rate floatValue], 0.5f);
    BOOL shouldAutoplay = autoplay == nil ? YES : [autoplay boolValue];
    self.manualPause = !shouldAutoplay;
    self.interruptedBySystem = NO;
    self.requestHeaders = [headers isKindOfClass:[NSDictionary class]] ? [headers copy] : @{};
    [self emitState:(shouldAutoplay ? @"loading" : @"paused") position:@0 duration:@0];

    NSURL *url = [NSURL URLWithString:urlString];
    if (url == nil) {
      NSError *error = LXError(@"streaming_flac_url", @"Invalid FLAC stream url");
      reject(@"streaming_flac_url", error.localizedDescription, error);
      return;
    }
    self.startThresholdSeconds = 1.5;
    [self startDecoderLoop];
    resolve(nil);
  });
}

RCT_REMAP_METHOD(resume, resumeStreamWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_sync(self.renderQueue, ^{
    self.manualPause = NO;
    self.interruptedBySystem = NO;
    [self maybeStartPlaybackLocked];
  });
  resolve(nil);
}

RCT_REMAP_METHOD(pause, pauseStreamWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_sync(self.renderQueue, ^{
    self.lastKnownPosition = [self currentPlaybackPositionLocked];
    self.manualPause = YES;
    self.interruptedBySystem = NO;
    [self.playerNode pause];
    self.playbackStarted = NO;
  });
  [self emitState:@"paused" position:@(self.lastKnownPosition) duration:@(self.duration)];
  resolve(nil);
}

RCT_REMAP_METHOD(stop, stopStreamWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  self.manualPause = YES;
  self.interruptedBySystem = NO;
  [self stopStreamingInternal:YES];
  self.currentState = @"stopped";
  [self emitState:@"stopped" position:@0 duration:@(self.duration)];
  resolve(nil);
}

RCT_REMAP_METHOD(reset, resetStreamWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  [self stopStreamingInternal:YES];
  [self resetStreamingState];
  self.currentState = @"idle";
  [self emitState:@"idle" position:@0 duration:@0];
  resolve(nil);
}

RCT_REMAP_METHOD(seekTo, seekToStream:(nonnull NSNumber *)position resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (self.currentURL.length == 0 || [self.currentState isEqualToString:@"idle"] || [self.currentState isEqualToString:@"stopped"]) {
    NSError *error = LXError(@"streaming_flac_seek", @"No streaming FLAC playback to seek");
    reject(@"streaming_flac_seek", error.localizedDescription, error);
    return;
  }
  if (self.decoder == NULL && self.sampleRate > 0) {
    NSError *error = LXError(@"streaming_flac_seek", @"Streaming FLAC decoder is no longer active");
    reject(@"streaming_flac_seek", error.localizedDescription, error);
    return;
  }

  double requestedPosition = MAX([position doubleValue], 0);
  if (self.duration > 0) requestedPosition = LXClampDouble(requestedPosition, 0, self.duration);
  __block double currentPosition = 0;
  dispatch_sync(self.renderQueue, ^{
    currentPosition = [self currentPlaybackPositionLocked];
  });
  BOOL shouldRestartDecoder = self.decoder == NULL || requestedPosition < currentPosition;

  dispatch_sync(self.renderQueue, ^{
    self.lastKnownPosition = requestedPosition;
    self.playbackGeneration += 1;
    if (self.playerNode != nil) [self.playerNode stop];
    self.queuedFrames = 0;
    self.completedFrames = self.sampleRate > 0 ? (int64_t)llround(requestedPosition * self.sampleRate) : 0;
    self.playbackAnchorFrame = self.completedFrames;
    self.playbackStarted = NO;
  });

  self.pendingSeekPosition = requestedPosition;
  self.seekRequested = NO;
  self.seekInProgress = self.sampleRate > 0 && requestedPosition > 0;
  self.fastForwardSeekActive = YES;
  self.startThresholdSeconds = self.seekStartThresholdSeconds;
  self.currentState = self.manualPause ? @"paused" : @"buffering";
  self.seekTargetFrame = self.sampleRate > 0 ? (int64_t)llround(requestedPosition * self.sampleRate) : 0;

  if (shouldRestartDecoder) {
    [self restartDecoderLoopForQuickSeek];
  } else {
    [self.streamCondition lock];
    [self.streamCondition broadcast];
    [self.streamCondition unlock];
  }

  [self emitState:self.currentState position:@(requestedPosition) duration:@(self.duration)];
  resolve(@(requestedPosition));
}

RCT_REMAP_METHOD(setVolume, setStreamVolume:(nonnull NSNumber *)volume resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  self.currentVolume = [volume floatValue];
  dispatch_sync(self.renderQueue, ^{
    if (self.playerNode != nil) self.playerNode.volume = self.currentVolume;
  });
  resolve(nil);
}

RCT_REMAP_METHOD(setRate, setStreamRate:(nonnull NSNumber *)rate resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  self.currentRate = MAX([rate floatValue], 0.5f);
  dispatch_sync(self.renderQueue, ^{
    if (self.timePitchNode != nil) self.timePitchNode.rate = self.currentRate;
  });
  resolve(nil);
}

RCT_REMAP_METHOD(getPosition, getStreamPositionWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  __block double position = 0;
  dispatch_sync(self.renderQueue, ^{
    position = [self currentPlaybackPositionLocked];
  });
  resolve(@(position));
}

RCT_REMAP_METHOD(getDuration, getStreamDurationWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(@(self.duration));
}

RCT_REMAP_METHOD(getState, getStreamStateWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  resolve(self.currentState ?: @"idle");
}

#if LX_HAS_LIBFLAC
- (FLAC__StreamDecoderReadStatus)readBytes:(FLAC__byte *)buffer bytes:(size_t *)bytes {
  if (self.stopRequested) return FLAC__STREAM_DECODER_READ_STATUS_ABORT;

  if (self.fullStreamData != nil) {
    NSUInteger available = self.currentByteOffset < (int64_t)self.fullStreamData.length
      ? (NSUInteger)((int64_t)self.fullStreamData.length - self.currentByteOffset)
      : 0;
    if (!available) {
      *bytes = 0;
      return FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM;
    }
    size_t count = MIN(*bytes, available);
    memcpy(buffer, ((const FLAC__byte *)self.fullStreamData.bytes) + self.currentByteOffset, count);
    self.currentByteOffset += (int64_t)count;
    *bytes = count;
    return FLAC__STREAM_DECODER_READ_STATUS_CONTINUE;
  }

  NSError *sourceError = nil;
  if (![self prepareRangeSourceIfNeeded:&sourceError]) {
    self.streamError = sourceError ?: LXError(@"streaming_flac_http", @"Failed to prepare FLAC range source");
    [self emitErrorMessage:self.streamError.localizedDescription];
    return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
  }

  if (self.streamLengthBytes > 0 && self.currentByteOffset >= self.streamLengthBytes) {
    *bytes = 0;
    return FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM;
  }

  size_t requested = *bytes;
  size_t copied = 0;
  while (copied < requested && !self.stopRequested) {
    if (self.streamLengthBytes > 0 && self.currentByteOffset >= self.streamLengthBytes) break;

    NSUInteger chunkIndex = (NSUInteger)(self.currentByteOffset / (int64_t)self.rangeChunkSize);
    if (![self fetchChunkAtIndex:chunkIndex error:&sourceError]) {
      self.streamError = sourceError ?: LXError(@"streaming_flac_http", @"Failed to read FLAC range chunk");
      [self emitErrorMessage:self.streamError.localizedDescription];
      return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
    }

    NSData *chunk = self.rangeChunkCache[@(chunkIndex)];
    if (chunk.length == 0) break;

    NSUInteger chunkOffset = (NSUInteger)(self.currentByteOffset - ((int64_t)chunkIndex * (int64_t)self.rangeChunkSize));
    if (chunkOffset >= chunk.length) break;

    size_t count = MIN(requested - copied, chunk.length - chunkOffset);
    memcpy(buffer + copied, ((const FLAC__byte *)chunk.bytes) + chunkOffset, count);
    copied += count;
    self.currentByteOffset += (int64_t)count;
  }

  *bytes = copied;
  if (copied > 0) return FLAC__STREAM_DECODER_READ_STATUS_CONTINUE;
  return self.streamLengthBytes > 0 && self.currentByteOffset >= self.streamLengthBytes
    ? FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM
    : FLAC__STREAM_DECODER_READ_STATUS_ABORT;
}

- (FLAC__StreamDecoderSeekStatus)seekToAbsoluteByteOffset:(FLAC__uint64)absoluteByteOffset {
  NSError *sourceError = nil;
  if (![self prepareRangeSourceIfNeeded:&sourceError]) {
    self.streamError = sourceError ?: LXError(@"streaming_flac_seek", @"Failed to prepare FLAC seek source");
    [self emitErrorMessage:self.streamError.localizedDescription];
    return FLAC__STREAM_DECODER_SEEK_STATUS_ERROR;
  }

  if (self.streamLengthBytes > 0 && absoluteByteOffset > (FLAC__uint64)self.streamLengthBytes) {
    return FLAC__STREAM_DECODER_SEEK_STATUS_ERROR;
  }

  self.currentByteOffset = (int64_t)absoluteByteOffset;
  [self trimRangeChunkCacheAroundByteOffset:self.currentByteOffset];
  return FLAC__STREAM_DECODER_SEEK_STATUS_OK;
}

- (FLAC__StreamDecoderTellStatus)tellAbsoluteByteOffset:(FLAC__uint64 *)absoluteByteOffset {
  if (absoluteByteOffset == NULL) return FLAC__STREAM_DECODER_TELL_STATUS_ERROR;
  *absoluteByteOffset = (FLAC__uint64)MAX((int64_t)0, self.currentByteOffset);
  return FLAC__STREAM_DECODER_TELL_STATUS_OK;
}

- (FLAC__StreamDecoderLengthStatus)getStreamLength:(FLAC__uint64 *)streamLength {
  NSError *sourceError = nil;
  if (![self prepareRangeSourceIfNeeded:&sourceError]) {
    self.streamError = sourceError ?: LXError(@"streaming_flac_http", @"Failed to read FLAC stream length");
    [self emitErrorMessage:self.streamError.localizedDescription];
    return FLAC__STREAM_DECODER_LENGTH_STATUS_ERROR;
  }
  if (streamLength == NULL || self.streamLengthBytes <= 0) return FLAC__STREAM_DECODER_LENGTH_STATUS_ERROR;
  *streamLength = (FLAC__uint64)self.streamLengthBytes;
  return FLAC__STREAM_DECODER_LENGTH_STATUS_OK;
}

- (FLAC__bool)isAtEndOfStream {
  return self.streamLengthBytes > 0 && self.currentByteOffset >= self.streamLengthBytes;
}

- (void)handleStreamInfo:(const FLAC__StreamMetadata_StreamInfo *)streamInfo {
  self.sampleRate = streamInfo->sample_rate;
  self.channels = streamInfo->channels;
  self.bitsPerSample = streamInfo->bits_per_sample;
  self.duration = streamInfo->total_samples > 0 && streamInfo->sample_rate > 0
    ? (double)streamInfo->total_samples / streamInfo->sample_rate
    : 0;
  [self configureAudioGraphWithSampleRate:self.sampleRate channels:self.channels bitsPerSample:self.bitsPerSample];
}

- (FLAC__StreamDecoderWriteStatus)handleFrame:(const FLAC__Frame *)frame buffer:(const FLAC__int32 * const[])decodedBuffer {
  if (self.streamError != nil) return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;

  const NSUInteger blockSize = frame->header.blocksize;
  const int64_t frameStart = (int64_t)frame->header.number.sample_number;
  const int64_t frameEnd = frameStart + (int64_t)blockSize;
  NSUInteger startOffset = 0;

  if (self.seekInProgress) {
    if (frameEnd <= self.seekTargetFrame) return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;
    if (self.seekTargetFrame > frameStart) startOffset = (NSUInteger)(self.seekTargetFrame - frameStart);
    self.seekInProgress = NO;
  }

  [self waitForBufferCapacityIfNeeded];
  if (self.stopRequested || self.seekRequested) return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;

  [self schedulePCMBufferWithFrame:frame buffer:decodedBuffer startOffset:startOffset];
  return self.streamError == nil ? FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE : FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
}

- (void)handleDecoderErrorStatus:(FLAC__StreamDecoderErrorStatus)status {
  if (self.stopRequested) return;
  self.streamError = LXError(@"streaming_flac_decode", [NSString stringWithFormat:@"FLAC decoder error: %d", status]);
  [self emitErrorMessage:self.streamError.localizedDescription];
  [self.streamCondition lock];
  [self.streamCondition broadcast];
  [self.streamCondition unlock];
}
#endif

@end

#if LX_HAS_LIBFLAC
static FLAC__StreamDecoderReadStatus LXStreamingFlacReadCallback(const FLAC__StreamDecoder *decoder, FLAC__byte buffer[], size_t *bytes, void *client_data) {
  return [(__bridge StreamingFlacPlayerModule *)client_data readBytes:buffer bytes:bytes];
}

static FLAC__StreamDecoderSeekStatus LXStreamingFlacSeekCallback(const FLAC__StreamDecoder *decoder, FLAC__uint64 absolute_byte_offset, void *client_data) {
  return [(__bridge StreamingFlacPlayerModule *)client_data seekToAbsoluteByteOffset:absolute_byte_offset];
}

static FLAC__StreamDecoderTellStatus LXStreamingFlacTellCallback(const FLAC__StreamDecoder *decoder, FLAC__uint64 *absolute_byte_offset, void *client_data) {
  return [(__bridge StreamingFlacPlayerModule *)client_data tellAbsoluteByteOffset:absolute_byte_offset];
}

static FLAC__StreamDecoderLengthStatus LXStreamingFlacLengthCallback(const FLAC__StreamDecoder *decoder, FLAC__uint64 *stream_length, void *client_data) {
  return [(__bridge StreamingFlacPlayerModule *)client_data getStreamLength:stream_length];
}

static FLAC__bool LXStreamingFlacEofCallback(const FLAC__StreamDecoder *decoder, void *client_data) {
  return [(__bridge StreamingFlacPlayerModule *)client_data isAtEndOfStream];
}

static FLAC__StreamDecoderWriteStatus LXStreamingFlacWriteCallback(const FLAC__StreamDecoder *decoder, const FLAC__Frame *frame, const FLAC__int32 * const buffer[], void *client_data) {
  return [(__bridge StreamingFlacPlayerModule *)client_data handleFrame:frame buffer:buffer];
}

static void LXStreamingFlacMetadataCallback(const FLAC__StreamDecoder *decoder, const FLAC__StreamMetadata *metadata, void *client_data) {
  if (metadata->type != FLAC__METADATA_TYPE_STREAMINFO) return;
  [(__bridge StreamingFlacPlayerModule *)client_data handleStreamInfo:&metadata->data.stream_info];
}

static void LXStreamingFlacErrorCallback(const FLAC__StreamDecoder *decoder, FLAC__StreamDecoderErrorStatus status, void *client_data) {
  [(__bridge StreamingFlacPlayerModule *)client_data handleDecoderErrorStatus:status];
}
#endif

@interface FilePickerModule : NSObject<RCTBridgeModule, UIDocumentPickerDelegate>
@property (nonatomic, copy) RCTPromiseResolveBlock pickerResolve;
@property (nonatomic, copy) RCTPromiseRejectBlock pickerReject;
@property (nonatomic, copy) NSString *targetPath;
@property (nonatomic, strong) UIDocumentPickerViewController *pickerController;
@property (nonatomic, assign) BOOL pickerPresenting;
@end

@implementation FilePickerModule

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

- (void)resetPickerState {
  self.pickerResolve = nil;
  self.pickerReject = nil;
  self.targetPath = nil;
  self.pickerController = nil;
  self.pickerPresenting = NO;
}

- (void)rejectPickerWithCode:(NSString *)code message:(NSString *)message error:(NSError *)error {
  if (self.pickerReject != nil) self.pickerReject(code, message, error);
  [self resetPickerState];
}

RCT_REMAP_METHOD(openDocument, openDocument:(NSDictionary *)options resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.pickerController != nil || self.pickerPresenting) {
      reject(@"picker_busy", @"Another picker is already active", LXError(@"picker_busy", @"Another picker is already active"));
      return;
    }

    UIViewController *controller = LXTopViewController();
    if (controller == nil) {
      reject(@"picker_present", @"Unable to find a view controller to present file picker", LXError(@"picker_present", @"Unable to find a view controller to present file picker"));
      return;
    }

    self.pickerResolve = resolve;
    self.pickerReject = reject;
    self.targetPath = [options[@"toPath"] isKindOfClass:[NSString class]] ? options[@"toPath"] : @"";

    NSArray<NSString *> *documentTypes = LXDocumentTypesForExtensions(options[@"extTypes"]);
    UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc] initWithDocumentTypes:documentTypes inMode:UIDocumentPickerModeImport];
    picker.delegate = self;
    picker.allowsMultipleSelection = NO;
    picker.modalPresentationStyle = UIModalPresentationFullScreen;
    self.pickerPresenting = YES;
    [controller presentViewController:picker animated:YES completion:^{
      self.pickerController = picker;
      self.pickerPresenting = NO;
    }];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      if (self.pickerPresenting && self.pickerController == nil) {
        [self rejectPickerWithCode:@"picker_present" message:@"File picker did not finish presenting" error:LXError(@"picker_present", @"File picker did not finish presenting")];
      }
    });
  });
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
  [controller dismissViewControllerAnimated:YES completion:nil];
  [self rejectPickerWithCode:@"picker_cancelled" message:@"Document selection was cancelled" error:LXError(@"picker_cancelled", @"Document selection was cancelled")];
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
  NSURL *pickedURL = urls.firstObject;
  [controller dismissViewControllerAnimated:YES completion:nil];

  if (pickedURL == nil) {
    [self rejectPickerWithCode:@"picker_empty" message:@"No document was selected" error:LXError(@"picker_empty", @"No document was selected")];
    return;
  }

  NSError *error = nil;
  BOOL startedAccessing = [pickedURL startAccessingSecurityScopedResource];
  NSString *targetPath = LXPrepareImportedFilePath(self.targetPath ?: @"", pickedURL, &error);
  if (targetPath == nil) {
    if (startedAccessing) [pickedURL stopAccessingSecurityScopedResource];
    [self rejectPickerWithCode:@"copy_target_failed" message:error.localizedDescription ?: @"Failed to prepare imported file path" error:error];
    return;
  }

  NSFileManager *fileManager = [NSFileManager defaultManager];
  [fileManager removeItemAtPath:targetPath error:nil];
  if (![fileManager copyItemAtURL:pickedURL toURL:[NSURL fileURLWithPath:targetPath] error:&error]) {
    if (startedAccessing) [pickedURL stopAccessingSecurityScopedResource];
    [self rejectPickerWithCode:@"copy_failed" message:error.localizedDescription ?: @"Failed to import selected file" error:error];
    return;
  }
  if (startedAccessing) [pickedURL stopAccessingSecurityScopedResource];

  NSDictionary *fileInfo = LXFileInfoFromPath(targetPath);
  NSMutableDictionary *result = fileInfo != nil ? [fileInfo mutableCopy] : [NSMutableDictionary dictionary];
  if (result == nil) result = [NSMutableDictionary dictionary];
  result[@"data"] = targetPath;
  if (self.pickerResolve != nil) self.pickerResolve(result);
  [self resetPickerState];
}

@end

@interface UserApiModule : RCTEventEmitter<RCTBridgeModule>
@property (nonatomic, strong) JSContext *jsContext;
@property (nonatomic, strong) dispatch_queue_t scriptQueue;
@property (nonatomic, copy) NSString *scriptKey;
@property (nonatomic, assign) BOOL initSent;
@property (nonatomic, assign) BOOL hasListeners;
@property (nonatomic, strong) NSDictionary *scriptInfo;
@end

@implementation UserApiModule

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (instancetype)init {
  self = [super init];
  if (self != nil) {
    _scriptQueue = dispatch_queue_create("cn.toside.music.mobile.userapi", DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (NSArray<NSString *> *)supportedEvents {
  return @[ @"api-action" ];
}

- (void)startObserving {
  self.hasListeners = YES;
}

- (void)stopObserving {
  self.hasListeners = NO;
}

- (void)emitLogWithType:(NSString *)type message:(NSString *)message {
  if (!self.hasListeners) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    [self sendEventWithName:@"api-action" body:@{
      @"action": @"log",
      @"type": type ?: @"log",
      @"log": message ?: @"",
    }];
  });
}

- (void)emitAction:(NSString *)action dataString:(NSString *)dataString errorMessage:(NSString *)errorMessage {
  if (!self.hasListeners) return;
  NSMutableDictionary *body = [NSMutableDictionary dictionaryWithObject:action forKey:@"action"];
  if (dataString != nil) body[@"data"] = dataString;
  if (errorMessage != nil) body[@"errorMessage"] = errorMessage;
  dispatch_async(dispatch_get_main_queue(), ^{
    [self sendEventWithName:@"api-action" body:body];
  });
}

- (NSString *)loadPreloadScript {
  NSString *path = [[NSBundle mainBundle] pathForResource:@"user-api-preload" ofType:@"js"];
  if (!path.length) return nil;
  return [NSString stringWithContentsOfFile:path encoding:NSUTF8StringEncoding error:nil];
}

- (void)emitInitFailed:(NSString *)message {
  NSDictionary *data = @{
    @"info": [NSNull null],
    @"status": @NO,
    @"errorMessage": message ?: @"Create JavaScript Env Failed",
  };
  [self emitAction:@"init" dataString:LXJSONString(data) errorMessage:(message ?: @"Create JavaScript Env Failed")];
  [self emitLogWithType:@"error" message:(message ?: @"Create JavaScript Env Failed")];
}

- (void)destroyContext {
  self.jsContext = nil;
  self.scriptKey = nil;
  self.initSent = NO;
  self.scriptInfo = nil;
}

- (void)callJSAction:(NSString *)action data:(id)data {
  if (self.jsContext == nil) return;
  JSValue *nativeCall = self.jsContext[@"__lx_native__"];
  if (nativeCall == nil || nativeCall.isUndefined) return;

  NSMutableArray *arguments = [NSMutableArray arrayWithObjects:self.scriptKey ?: @"", action ?: @"", nil];
  if (data != nil) {
    NSString *jsonString = [data isKindOfClass:[NSString class]] ? data : LXJSONString(data);
    if (jsonString != nil) [arguments addObject:jsonString];
  }
  [nativeCall callWithArguments:arguments];
}

- (BOOL)createJSEnv:(NSDictionary *)scriptInfo error:(NSString **)errorMessage {
  self.scriptKey = NSUUID.UUID.UUIDString;
  self.scriptInfo = scriptInfo;
  self.initSent = NO;
  JSContext *context = [[JSContext alloc] init];
  self.jsContext = context;

  __weak UserApiModule *weakSelf = self;
  __block NSString *lastException = nil;
  context.exceptionHandler = ^(JSContext *ctx, JSValue *exception) {
    ctx.exception = exception;
    lastException = exception.toString ?: @"Unknown JavaScript exception";
    [weakSelf emitLogWithType:@"error" message:[NSString stringWithFormat:@"Call script error: %@", lastException]];
  };

  context[@"globalThis"] = context.globalObject;
  context[@"window"] = context.globalObject;
  context[@"self"] = context.globalObject;
  context[@"global"] = context.globalObject;

  JSValue *console = [JSValue valueWithNewObjectInContext:context];
  console[@"log"] = ^{ [weakSelf emitLogWithType:@"log" message:LXJoinJSArguments([JSContext currentArguments])]; };
  console[@"info"] = ^{ [weakSelf emitLogWithType:@"info" message:LXJoinJSArguments([JSContext currentArguments])]; };
  console[@"warn"] = ^{ [weakSelf emitLogWithType:@"warn" message:LXJoinJSArguments([JSContext currentArguments])]; };
  console[@"error"] = ^{ [weakSelf emitLogWithType:@"error" message:LXJoinJSArguments([JSContext currentArguments])]; };
  context[@"console"] = console;

  context[@"__lx_native_call__"] = ^id(NSString *key, NSString *action, NSString *data) {
    if (![weakSelf.scriptKey isEqualToString:key]) return nil;
    if ([action isEqualToString:@"init"]) {
      if (weakSelf.initSent) return nil;
      weakSelf.initSent = YES;
    }
    [weakSelf emitAction:action dataString:data errorMessage:nil];
    return nil;
  };

  context[@"__lx_native_call__utils_str2b64"] = ^NSString *(NSString *input) {
    NSData *data = [input dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
    return [data base64EncodedStringWithOptions:0];
  };

  context[@"__lx_native_call__utils_b642buf"] = ^NSString *(NSString *input) {
    NSData *data = [[NSData alloc] initWithBase64EncodedString:input options:NSDataBase64DecodingIgnoreUnknownCharacters] ?: [NSData data];
    NSMutableArray<NSNumber *> *result = [NSMutableArray arrayWithCapacity:data.length];
    const unsigned char *bytes = (const unsigned char *)data.bytes;
    for (NSUInteger index = 0; index < data.length; index++) {
      [result addObject:@((NSInteger)bytes[index])];
    }
    return LXJSONString(result) ?: @"[]";
  };

  context[@"__lx_native_call__utils_str2md5"] = ^NSString *(NSString *input) {
    NSString *decoded = [input stringByRemovingPercentEncoding] ?: input ?: @"";
    NSData *data = [decoded dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
    unsigned char digest[CC_MD5_DIGEST_LENGTH];
    CC_MD5(data.bytes, (CC_LONG)data.length, digest);
    NSMutableString *hash = [NSMutableString stringWithCapacity:CC_MD5_DIGEST_LENGTH * 2];
    for (NSInteger i = 0; i < CC_MD5_DIGEST_LENGTH; i++) {
      [hash appendFormat:@"%02x", digest[i]];
    }
    return hash;
  };

  context[@"__lx_native_call__utils_aes_encrypt"] = ^NSString *(NSString *text, NSString *key, NSString *iv, NSString *mode) {
    return LXAES(text ?: @"", key ?: @"", iv ?: @"", mode ?: @"", kCCEncrypt, nil) ?: @"";
  };

  context[@"__lx_native_call__utils_rsa_encrypt"] = ^NSString *(NSString *text, NSString *key, NSString *padding) {
    return LXRSAEncrypt(text ?: @"", key ?: @"", padding ?: @"", nil) ?: @"";
  };

  context[@"__lx_native_call__set_timeout"] = ^id(NSNumber *identifier, NSNumber *timeout) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(MAX(timeout.doubleValue, 0) * NSEC_PER_MSEC)), weakSelf.scriptQueue, ^{
      [weakSelf callJSAction:@"__set_timeout__" data:identifier ?: @0];
    });
    return nil;
  };

  NSString *preloadScript = [self loadPreloadScript];
  if (!preloadScript.length) {
    if (errorMessage != NULL) *errorMessage = @"create JavaScript Env failed";
    return NO;
  }

  [context evaluateScript:preloadScript];
  if (lastException.length) {
    if (errorMessage != NULL) *errorMessage = lastException;
    return NO;
  }

  JSValue *setup = context[@"lx_setup"];
  [setup callWithArguments:@[
    self.scriptKey ?: @"",
    scriptInfo[@"id"] ?: @"",
    scriptInfo[@"name"] ?: @"Unknown",
    scriptInfo[@"description"] ?: @"",
    scriptInfo[@"version"] ?: @"",
    scriptInfo[@"author"] ?: @"",
    scriptInfo[@"homepage"] ?: @"",
    scriptInfo[@"script"] ?: @"",
  ]];
  if (lastException.length) {
    if (errorMessage != NULL) *errorMessage = lastException;
    return NO;
  }
  return YES;
}

RCT_EXPORT_METHOD(loadScript:(NSDictionary *)data) {
  dispatch_async(self.scriptQueue, ^{
    [self destroyContext];
    NSString *errorMessage = nil;
    if (![self createJSEnv:data error:&errorMessage]) {
      [self emitInitFailed:errorMessage];
      return;
    }

    __weak UserApiModule *weakSelf = self;
    __block NSString *lastException = nil;
    self.jsContext.exceptionHandler = ^(JSContext *ctx, JSValue *exception) {
      ctx.exception = exception;
      lastException = exception.toString ?: @"Unknown JavaScript exception";
      [weakSelf emitLogWithType:@"error" message:[NSString stringWithFormat:@"Call script error: %@", lastException]];
    };

    [self.jsContext evaluateScript:data[@"script"] ?: @""];
    if (lastException.length) {
      [weakSelf callJSAction:@"__run_error__" data:nil];
      if (!weakSelf.initSent) {
        weakSelf.initSent = YES;
        [weakSelf emitInitFailed:lastException];
      }
    }
  });
}

RCT_EXPORT_METHOD(sendAction:(NSString *)action info:(NSString *)info) {
  dispatch_async(self.scriptQueue, ^{
    if (self.jsContext == nil) return;
    [self callJSAction:action data:info];
  });
}

RCT_EXPORT_METHOD(destroy) {
  dispatch_async(self.scriptQueue, ^{
    [self destroyContext];
  });
}

@end

static NSString *LXMediaMetadataSidecarPath(NSString *filePath) {
  return [filePath stringByAppendingString:@".lxmeta.json"];
}

static NSString *LXMediaLyricSidecarPath(NSString *filePath) {
  NSString *basePath = [filePath stringByDeletingPathExtension];
  return [basePath stringByAppendingPathExtension:@"lrc"];
}

static NSString *LXMediaCoverSidecarPrefix(NSString *filePath) {
  return [filePath stringByAppendingString:@".lxcover"];
}

static NSString *LXAudioExtForPath(NSString *filePath) {
  NSString *ext = filePath.pathExtension.lowercaseString;
  if ([ext isEqualToString:@"flac"] ||
      [ext isEqualToString:@"ogg"] ||
      [ext isEqualToString:@"wav"] ||
      [ext isEqualToString:@"m4a"] ||
      [ext isEqualToString:@"aac"]) return ext;
  return @"mp3";
}

static NSDictionary *LXReadJSONFile(NSString *path) {
  NSData *data = [NSData dataWithContentsOfFile:path];
  if (!data.length) return @{};
  id result = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [result isKindOfClass:[NSDictionary class]] ? result : @{};
}

static BOOL LXWriteJSONFile(NSString *path, NSDictionary *json, NSError **error) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:json options:0 error:error];
  if (!data) return NO;
  return [data writeToFile:path options:NSDataWritingAtomic error:error];
}

static NSArray<AVMetadataItem *> *LXAllMetadataItems(AVAsset *asset) {
  NSMutableArray<AVMetadataItem *> *items = [NSMutableArray array];
  [items addObjectsFromArray:asset.commonMetadata];
  for (NSString *format in asset.availableMetadataFormats) {
    [items addObjectsFromArray:[asset metadataForFormat:format]];
  }
  return items;
}

static NSString *LXMetadataStringValue(id value) {
  if ([value isKindOfClass:[NSString class]]) return value;
  if ([value isKindOfClass:[NSNumber class]]) return ((NSNumber *)value).stringValue;
  return @"";
}

static NSString *LXFindMetadataString(AVAsset *asset, NSArray<NSString *> *commonKeys, NSArray<NSString *> *identifierKeywords) {
  NSArray<AVMetadataItem *> *items = LXAllMetadataItems(asset);
  for (AVMetadataItem *item in items) {
    NSString *commonKey = item.commonKey.lowercaseString ?: @"";
    NSString *identifier = item.identifier.lowercaseString ?: @"";
    BOOL matched = [commonKeys containsObject:commonKey];
    if (!matched) {
      for (NSString *keyword in identifierKeywords) {
        if ([identifier containsString:keyword]) {
          matched = YES;
          break;
        }
      }
    }
    if (!matched) continue;
    NSString *stringValue = item.stringValue ?: LXMetadataStringValue(item.value);
    if (stringValue.length) return stringValue;
  }
  return @"";
}

static NSData *LXFindArtworkData(AVAsset *asset) {
  NSArray<AVMetadataItem *> *items = LXAllMetadataItems(asset);
  for (AVMetadataItem *item in items) {
    NSString *commonKey = item.commonKey.lowercaseString ?: @"";
    NSString *identifier = item.identifier.lowercaseString ?: @"";
    if (![commonKey isEqualToString:@"artwork"] &&
        ![identifier containsString:@"artwork"] &&
        ![identifier containsString:@"covr"] &&
        ![identifier containsString:@"apic"]) continue;

    if (item.dataValue.length) return item.dataValue;
    if ([item.value isKindOfClass:[NSData class]]) return (NSData *)item.value;
    if ([item.value isKindOfClass:[NSDictionary class]]) {
      id data = ((NSDictionary *)item.value)[@"data"];
      if ([data isKindOfClass:[NSData class]]) return data;
    }
  }
  return nil;
}

static NSString *LXImageExtensionForData(NSData *data) {
  if (data.length >= 8) {
    const uint8_t *bytes = (const uint8_t *)data.bytes;
    if (bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47) return @"png";
    if (bytes[0] == 0xFF && bytes[1] == 0xD8) return @"jpg";
    if (bytes[0] == 'G' && bytes[1] == 'I' && bytes[2] == 'F') return @"gif";
  }
  return @"jpg";
}

static NSString *LXFindCoverSidecarPath(NSString *filePath) {
  NSString *directory = [filePath stringByDeletingLastPathComponent];
  NSString *prefix = [[filePath.lastPathComponent stringByAppendingString:@".lxcover."] lowercaseString];
  NSArray<NSString *> *contents = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:directory error:nil] ?: @[];
  for (NSString *name in contents) {
    if ([name.lowercaseString hasPrefix:prefix]) {
      return [directory stringByAppendingPathComponent:name];
    }
  }
  return nil;
}

static void LXRemoveCoverSidecars(NSString *filePath) {
  NSString *directory = [filePath stringByDeletingLastPathComponent];
  NSString *prefix = [[filePath.lastPathComponent stringByAppendingString:@".lxcover."] lowercaseString];
  NSArray<NSString *> *contents = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:directory error:nil] ?: @[];
  for (NSString *name in contents) {
    if ([name.lowercaseString hasPrefix:prefix]) {
      NSString *target = [directory stringByAppendingPathComponent:name];
      [[NSFileManager defaultManager] removeItemAtPath:target error:nil];
    }
  }
}

@interface LocalMediaMetadata : NSObject<RCTBridgeModule>
@end

@implementation LocalMediaMetadata

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

RCT_REMAP_METHOD(readMetadata, readMetadata:(NSString *)filePath resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSURL *fileURL = [NSURL fileURLWithPath:filePath];
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:fileURL options:nil];
  NSDictionary *sidecar = LXReadJSONFile(LXMediaMetadataSidecarPath(filePath));
  NSDictionary *attributes = [[NSFileManager defaultManager] attributesOfItemAtPath:filePath error:nil] ?: @{};

  NSString *title = sidecar[@"name"];
  if (![title isKindOfClass:[NSString class]] || !title.length) {
    title = LXFindMetadataString(asset, @[ @"title" ], @[ @"title" ]);
  }
  if (!title.length) title = fileURL.URLByDeletingPathExtension.lastPathComponent ?: fileURL.lastPathComponent ?: @"";

  NSString *artist = sidecar[@"singer"];
  if (![artist isKindOfClass:[NSString class]] || !artist.length) {
    artist = LXFindMetadataString(asset, @[ @"artist", @"creator" ], @[ @"artist", @"author", @"performer" ]);
  }
  if (!artist.length) artist = @"";

  NSString *albumName = sidecar[@"albumName"];
  if (![albumName isKindOfClass:[NSString class]] || !albumName.length) {
    albumName = LXFindMetadataString(asset, @[ @"albumname" ], @[ @"album" ]);
  }
  if (!albumName.length) albumName = @"";

  AVAssetTrack *audioTrack = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
  NSInteger bitrate = audioTrack != nil ? (NSInteger)llround(audioTrack.estimatedDataRate / 1000.0) : 0;
  Float64 duration = CMTimeGetSeconds(asset.duration);
  if (!isfinite(duration) || duration < 0) duration = 0;

  NSString *ext = LXAudioExtForPath(filePath);
  resolve(@{
    @"type": ext,
    @"bitrate": @(bitrate).stringValue ?: @"0",
    @"interval": @((NSInteger)llround(duration)),
    @"size": attributes[NSFileSize] ?: @0,
    @"ext": ext,
    @"albumName": albumName,
    @"singer": artist,
    @"name": title,
  });
}

RCT_REMAP_METHOD(writeMetadata, writeMetadata:(NSString *)filePath metadata:(NSDictionary *)metadata overwrite:(BOOL)isOverwrite resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSMutableDictionary *sidecar = [LXReadJSONFile(LXMediaMetadataSidecarPath(filePath)) mutableCopy];
  if (sidecar == nil) sidecar = [NSMutableDictionary dictionary];

  for (NSString *key in @[ @"name", @"singer", @"albumName" ]) {
    NSString *value = [metadata[key] isKindOfClass:[NSString class]] ? metadata[key] : @"";
    sidecar[key] = value;
  }

  NSError *error = nil;
  if (!LXWriteJSONFile(LXMediaMetadataSidecarPath(filePath), sidecar, &error)) {
    reject(@"write_metadata_failed", error.localizedDescription ?: @"Failed to write metadata", error);
    return;
  }
  resolve(nil);
}

RCT_REMAP_METHOD(readPic, readPic:(NSString *)filePath targetPath:(NSString *)targetPath resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *sidecarCoverPath = LXFindCoverSidecarPath(filePath);
  NSData *coverData = nil;
  NSString *ext = @"jpg";
  if (sidecarCoverPath.length) {
    coverData = [NSData dataWithContentsOfFile:sidecarCoverPath];
    ext = sidecarCoverPath.pathExtension.length ? sidecarCoverPath.pathExtension.lowercaseString : @"jpg";
  } else {
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:filePath] options:nil];
    coverData = LXFindArtworkData(asset);
    if (coverData.length) ext = LXImageExtensionForData(coverData);
  }

  if (!coverData.length) {
    reject(@"read_pic_failed", @"No picture metadata found", nil);
    return;
  }

  NSError *error = nil;
  [[NSFileManager defaultManager] createDirectoryAtPath:targetPath withIntermediateDirectories:YES attributes:nil error:&error];
  if (error != nil) {
    reject(@"read_pic_failed", error.localizedDescription ?: @"Failed to create picture cache directory", error);
    return;
  }

  NSString *targetFilePath = [targetPath stringByAppendingPathComponent:[NSString stringWithFormat:@"%@.%@", LXSHA1(filePath), ext]];
  if (![coverData writeToFile:targetFilePath options:NSDataWritingAtomic error:&error]) {
    reject(@"read_pic_failed", error.localizedDescription ?: @"Failed to save picture", error);
    return;
  }

  resolve(targetFilePath);
}

RCT_REMAP_METHOD(writePic, writePic:(NSString *)filePath picPath:(NSString *)picPath resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSString *ext = picPath.pathExtension.lowercaseString.length ? picPath.pathExtension.lowercaseString : @"jpg";
  NSString *targetPath = [NSString stringWithFormat:@"%@.%@", LXMediaCoverSidecarPrefix(filePath), ext];
  NSError *error = nil;
  LXRemoveCoverSidecars(filePath);
  if (![[NSFileManager defaultManager] copyItemAtPath:picPath toPath:targetPath error:&error]) {
    reject(@"write_pic_failed", error.localizedDescription ?: @"Failed to save picture", error);
    return;
  }
  resolve(nil);
}

RCT_REMAP_METHOD(readLyric, readLyric:(NSString *)filePath isReadLrcFile:(BOOL)isReadLrcFile resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (isReadLrcFile) {
    NSString *lrcPath = LXMediaLyricSidecarPath(filePath);
    if ([[NSFileManager defaultManager] fileExistsAtPath:lrcPath]) {
      NSString *lyric = [NSString stringWithContentsOfFile:lrcPath encoding:NSUTF8StringEncoding error:nil];
      resolve(lyric ?: @"");
      return;
    }
  }

  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:filePath] options:nil];
  NSString *lyric = LXFindMetadataString(asset, @[], @[ @"lyric", @"lyrics", @"uslt" ]);
  resolve(lyric ?: @"");
}

RCT_REMAP_METHOD(writeLyric, writeLyric:(NSString *)filePath lyric:(NSString *)lyric resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  NSError *error = nil;
  NSString *lrcPath = LXMediaLyricSidecarPath(filePath);
  if (![lyric ?: @"" writeToFile:lrcPath atomically:YES encoding:NSUTF8StringEncoding error:&error]) {
    reject(@"write_lyric_failed", error.localizedDescription ?: @"Failed to save lyric", error);
    return;
  }
  resolve(nil);
}

@end

@interface CacheModule : NSObject<RCTBridgeModule>
@end

@implementation CacheModule

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

RCT_REMAP_METHOD(getAppCacheSize, getAppCacheSizeWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    unsigned long long total = 0;
    for (NSString *path in LXCacheDirectories()) {
      total += LXDirectorySize(path);
    }
    resolve(@((double)total));
  });
}

RCT_REMAP_METHOD(clearAppCache, clearAppCacheWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
    NSError *error = nil;
    for (NSString *path in LXCacheDirectories()) {
      if (!LXClearDirectoryContents(path, &error)) {
        reject(@"clear_cache_failed", error.localizedDescription ?: @"Failed to clear app cache", error);
        return;
      }
    }
    [[NSURLCache sharedURLCache] removeAllCachedResponses];
    resolve(nil);
  });
}

@end

@interface NowPlayingModule : NSObject<RCTBridgeModule>
@end

@implementation NowPlayingModule

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

RCT_REMAP_METHOD(updateNowPlayingInfo, updateNowPlayingInfo:(NSDictionary *)metadata resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    LXSetNowPlayingInfo(metadata ?: @{});
    resolve(nil);
  });
}

RCT_REMAP_METHOD(playNowPlaying, playNowPlaying:(NSDictionary *)options resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    LXSetNowPlayingPlaybackState(MPNowPlayingPlaybackStatePlaying, options);
    resolve(nil);
  });
}

RCT_REMAP_METHOD(pauseNowPlaying, pauseNowPlaying:(NSDictionary *)options resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    LXSetNowPlayingPlaybackState(MPNowPlayingPlaybackStatePaused, options);
    resolve(nil);
  });
}

RCT_REMAP_METHOD(stopNowPlaying, stopNowPlaying:(NSDictionary *)options resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    LXSetNowPlayingPlaybackState(MPNowPlayingPlaybackStateStopped, options);
    resolve(nil);
  });
}

RCT_REMAP_METHOD(clearNowPlayingInfo, clearNowPlayingInfoWithResolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    LXClearNowPlayingInfo();
    resolve(nil);
  });
}

@end

@interface UtilsModule : NSObject<RCTBridgeModule>
@end

@implementation UtilsModule

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup {
  return YES;
}

RCT_EXPORT_METHOD(addListener:(NSString *)eventName) {
  (void)eventName;
}

RCT_EXPORT_METHOD(removeListeners:(double)count) {
  (void)count;
}

RCT_EXPORT_METHOD(exitApp) {
  dispatch_async(dispatch_get_main_queue(), ^{
    exit(0);
  });
}

@end

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
  LXRegisterTrackPlayerLifecycleObserver();
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
