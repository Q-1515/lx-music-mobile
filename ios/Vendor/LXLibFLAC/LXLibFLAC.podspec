Pod::Spec.new do |s|
  license_text = File.read(File.join(__dir__, 'COPYING.Xiph'))

  s.name = 'LXLibFLAC'
  s.version = '1.5.0'
  s.summary = 'Vendored libFLAC sources for iOS streaming playback experiments'
  s.homepage = 'https://github.com/xiph/flac'
  s.license = { :type => 'BSD-3-Clause', :text => license_text }
  s.author = { 'Xiph.Org Foundation' => 'xiph.org' }
  s.source = { :git => 'https://github.com/xiph/flac.git', :tag => s.version.to_s }
  s.platform = :ios, '13.4'
  s.requires_arc = false

  s.source_files = [
    'lx_libflac_config.h',
    'include/FLAC/*.{h}',
    'include/share/**/*.{h}',
    'src/include/private/*.{h}',
    'src/include/protected/*.{h}',
    'src/bitmath.c',
    'src/bitreader.c',
    'src/bitwriter.c',
    'src/alloc.c',
    'src/cpu.c',
    'src/crc.c',
    'src/fixed.c',
    'src/float.c',
    'src/format.c',
    'src/lpc.c',
    'src/md5.c',
    'src/memory.c',
    'src/metadata_iterators.c',
    'src/metadata_object.c',
    'src/stream_decoder.c',
    'src/window.c',
  ]

  s.public_header_files = 'include/FLAC/*.h'
  s.header_mappings_dir = 'include'
  s.preserve_paths = [
    'lx_libflac_config.h',
    'include/FLAC/*.h',
    'include/share/**/*.{h}',
    'src/include/private/*.h',
    'src/include/protected/*.h',
  ]

  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}" "${PODS_TARGET_SRCROOT}/include" "${PODS_TARGET_SRCROOT}/src/include" "${PODS_TARGET_SRCROOT}/src/include/private" "${PODS_TARGET_SRCROOT}/src/include/protected"',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'gnu++17',
  }
end
