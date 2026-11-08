# 안드로이드 앱(APK) 빌드

`.github/workflows/android.yml`이 GitHub Actions에서 Capacitor로 APK를 만들고
[릴리스](https://github.com/hojung1231/harmony-coach/releases/tag/android)에 올립니다.

- 앱은 `https://hojung1231.github.io/harmony-coach/` 웹앱을 감싸서 실행합니다.
  그래서 웹앱을 고치면 APK를 다시 설치하지 않아도 앱 안 **업데이트** 버튼으로 반영됩니다.
- `debug.keystore`: 항상 같은 서명으로 빌드해서, 새 APK를 덮어 설치해도 저장한 노래가 지워지지 않게 합니다.
  (개인용 서명 키입니다. 플레이스토어 배포용 키가 아닙니다.)
- APK를 다시 빌드하려면: Actions → "Build Android APK" → Run workflow
