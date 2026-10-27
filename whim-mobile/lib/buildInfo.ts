import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Prefer the installed binary. Manifest fallbacks are explicitly labelled so
// analytics never mistake an updated app.json for a different installed build.
const nativeBuild = Platform.OS === 'ios'
  ? Constants.platform?.ios?.buildNumber
  : Platform.OS === 'android' ? Constants.platform?.android?.versionCode : null;
const manifestBuild = Platform.OS === 'ios'
  ? Constants.expoConfig?.ios?.buildNumber
  : Platform.OS === 'android' ? Constants.expoConfig?.android?.versionCode : null;
const build = nativeBuild ?? manifestBuild;

export const BUILD_INFO = {
  app_version: Constants.expoConfig?.version ?? 'unknown',
  build_number: build == null ? null : String(build),
  build_source: nativeBuild != null ? 'native' : manifestBuild != null ? 'manifest' : 'unknown',
  environment: __DEV__ ? 'development' : 'release',
  platform: Platform.OS,
};
export const APP_VERSION = `${BUILD_INFO.app_version}${build == null ? '' : ` (${build})`}`;
