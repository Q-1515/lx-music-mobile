#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$ROOT_DIR/build"
HEADERS_DIR="$BUILD_DIR/Headers"
DEVICE_BUILD_DIR="$BUILD_DIR/device"
SIM_BUILD_DIR="$BUILD_DIR/simulator"
SIM_ARM64_DIR="$BUILD_DIR/sim-arm64"
SIM_X64_DIR="$BUILD_DIR/sim-x86_64"
XCFRAMEWORK_PATH="$BUILD_DIR/LXLibFLAC.xcframework"

IOS_MIN_VERSION="13.4"

SOURCES=(
  "src/alloc.c"
  "src/bitmath.c"
  "src/bitreader.c"
  "src/bitwriter.c"
  "src/cpu.c"
  "src/crc.c"
  "src/fixed.c"
  "src/float.c"
  "src/format.c"
  "src/lpc.c"
  "src/md5.c"
  "src/memory.c"
  "src/metadata_iterators.c"
  "src/metadata_object.c"
  "src/stream_decoder.c"
  "src/window.c"
)

COMMON_FLAGS=(
  -std=gnu11
  -O3
  -DNDEBUG
  -I"$ROOT_DIR"
  -I"$ROOT_DIR/include"
  -I"$ROOT_DIR/src/include"
  -I"$ROOT_DIR/src/include/private"
  -I"$ROOT_DIR/src/include/protected"
)

copy_headers() {
  rm -rf "$HEADERS_DIR"
  mkdir -p "$HEADERS_DIR"
  cp -R "$ROOT_DIR/include/FLAC" "$HEADERS_DIR/FLAC"
}

compile_static_lib() {
  local sdk="$1"
  local arch="$2"
  local target_dir="$3"
  local min_flag="$4"
  local sdk_path
  sdk_path="$(xcrun --sdk "$sdk" --show-sdk-path)"

  rm -rf "$target_dir"
  mkdir -p "$target_dir/obj"

  for source in "${SOURCES[@]}"; do
    local base_name
    base_name="$(basename "${source%.*}")"
    xcrun --sdk "$sdk" clang \
      -arch "$arch" \
      -isysroot "$sdk_path" \
      "$min_flag" \
      "${COMMON_FLAGS[@]}" \
      -c "$ROOT_DIR/$source" \
      -o "$target_dir/obj/${base_name}.o"
  done

  libtool -static -o "$target_dir/libLXLibFLAC.a" "$target_dir"/obj/*.o
}

copy_headers
rm -rf "$XCFRAMEWORK_PATH"

compile_static_lib iphoneos arm64 "$DEVICE_BUILD_DIR" "-miphoneos-version-min=$IOS_MIN_VERSION"
compile_static_lib iphonesimulator arm64 "$SIM_ARM64_DIR" "-mios-simulator-version-min=$IOS_MIN_VERSION"
compile_static_lib iphonesimulator x86_64 "$SIM_X64_DIR" "-mios-simulator-version-min=$IOS_MIN_VERSION"

rm -rf "$SIM_BUILD_DIR"
mkdir -p "$SIM_BUILD_DIR"
lipo -create \
  "$SIM_ARM64_DIR/libLXLibFLAC.a" \
  "$SIM_X64_DIR/libLXLibFLAC.a" \
  -output "$SIM_BUILD_DIR/libLXLibFLAC.a"

xcodebuild -create-xcframework \
  -library "$DEVICE_BUILD_DIR/libLXLibFLAC.a" -headers "$HEADERS_DIR" \
  -library "$SIM_BUILD_DIR/libLXLibFLAC.a" -headers "$HEADERS_DIR" \
  -output "$XCFRAMEWORK_PATH"

echo "Built $XCFRAMEWORK_PATH"
