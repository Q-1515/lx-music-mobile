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
    'include/FLAC/*.{h}',
  ]

  s.public_header_files = 'include/FLAC/*.h'
  s.header_mappings_dir = 'include'
  s.vendored_frameworks = 'build/LXLibFLAC.xcframework'
  s.preserve_paths = [
    'build/LXLibFLAC.xcframework',
    'build_xcframework.sh',
    'lx_libflac_config.h',
    'include/FLAC/*.h',
    'include/share/**/*.{h}',
    'src/alloc.c',
    'src/*.c',
    'src/include/private/*.h',
    'src/include/protected/*.h',
  ]

  s.pod_target_xcconfig = {
    'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/include"',
  }
end
