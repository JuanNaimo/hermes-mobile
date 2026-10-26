require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  # Capacitor's Podfile names the pod after the npm package (fixName).
  s.name = 'CapacitorNativeWebsocket'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/JuanNaimo/hermes-mobile'
  s.author = 'hermes-mobile'
  s.source = { :git => 'https://github.com/JuanNaimo/hermes-mobile.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '14.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.1'
end
