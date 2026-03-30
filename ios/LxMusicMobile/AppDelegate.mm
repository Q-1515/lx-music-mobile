#import "AppDelegate.h"
#import <CommonCrypto/CommonCryptor.h>
#import <CommonCrypto/CommonDigest.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTBundleURLProvider.h>
#import <ReactNativeNavigation/ReactNativeNavigation.h>
#import <Security/Security.h>
#import <AVFoundation/AVFoundation.h>
#import <math.h>

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

@interface FilePickerModule : NSObject<RCTBridgeModule, UIDocumentPickerDelegate>
@property (nonatomic, copy) RCTPromiseResolveBlock pickerResolve;
@property (nonatomic, copy) RCTPromiseRejectBlock pickerReject;
@property (nonatomic, copy) NSString *targetPath;
@property (nonatomic, strong) UIDocumentPickerViewController *pickerController;
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
}

- (void)rejectPickerWithCode:(NSString *)code message:(NSString *)message error:(NSError *)error {
  if (self.pickerReject != nil) self.pickerReject(code, message, error);
  [self resetPickerState];
}

RCT_REMAP_METHOD(openDocument, openDocument:(NSDictionary *)options resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.pickerController != nil) {
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

    UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc] initWithDocumentTypes:@[@"public.data", @"public.item"] inMode:UIDocumentPickerModeOpen];
    picker.delegate = self;
    picker.allowsMultipleSelection = NO;
    picker.modalPresentationStyle = UIModalPresentationFullScreen;
    self.pickerController = picker;
    [controller presentViewController:picker animated:YES completion:nil];
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
