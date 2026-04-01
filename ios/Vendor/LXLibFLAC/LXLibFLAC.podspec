Pod::Spec.new do |s|
  s.name = 'LXLibFLAC'
  s.version = '1.5.0'
  s.summary = 'Vendored libFLAC sources for iOS streaming playback experiments'
  s.homepage = 'https://github.com/xiph/flac'
  s.license = { :type => 'BSD', :file => 'COPYING.Xiph' }
  s.author = { 'Xiph.Org Foundation' => 'xiph.org' }
  s.source = { :path => '.' }
  s.platform = :ios, '13.4'
  s.requires_arc = false

  s.source_files = [
    'config.h',
    'include/FLAC/*.{h}',
    'src/include/private/*.{h}',
    'src/include/protected/*.{h}',
    'src/bitmath.c',
    'src/bitreader.c',
    'src/bitwriter.c',
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
    'config.h',
    'include/FLAC/*.h',
    'src/include/private/*.h',
    'src/include/protected/*.h',
  ]

  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}" "${PODS_TARGET_SRCROOT}/include" "${PODS_TARGET_SRCROOT}/src/include/private" "${PODS_TARGET_SRCROOT}/src/include/protected"',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'gnu++17',
  }
end
