#!/usr/bin/env bash
# Installs the Android build toolchain (JDK 17, Android SDK cmdline-tools,
# Gradle) into a user-space directory if it isn't already there, then builds
# the debug APK. No root/sudo required. Safe to re-run: every install step
# is skipped if already present.
set -euo pipefail

TOOLCHAIN_DIR="${TOOLCHAIN_DIR:-$HOME/android-toolchain}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

JDK_URL="https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
GRADLE_URL="https://services.gradle.org/distributions/gradle-8.7-bin.zip"

mkdir -p "$TOOLCHAIN_DIR"
cd "$TOOLCHAIN_DIR"

if [ ! -x jdk17/bin/java ]; then
  echo "== Installing JDK 17 =="
  curl -sL --max-time 300 -o jdk17.tar.gz "$JDK_URL"
  rm -rf jdk17
  tar xzf jdk17.tar.gz
  mv jdk-17*/ jdk17
  rm jdk17.tar.gz
fi

if [ ! -x sdk/cmdline-tools/latest/bin/sdkmanager ]; then
  echo "== Installing Android cmdline-tools =="
  curl -sL --max-time 300 -o cmdline-tools.zip "$CMDLINE_TOOLS_URL"
  rm -rf sdk/cmdline-tools
  mkdir -p sdk/cmdline-tools
  unzip -q cmdline-tools.zip -d sdk/cmdline-tools
  mv sdk/cmdline-tools/cmdline-tools sdk/cmdline-tools/latest
  rm cmdline-tools.zip
fi

if [ ! -x gradle/bin/gradle ]; then
  echo "== Installing Gradle 8.7 =="
  curl -sL --max-time 300 -o gradle-8.7-bin.zip "$GRADLE_URL"
  rm -rf gradle
  unzip -q gradle-8.7-bin.zip
  mv gradle-8.7 gradle
  rm gradle-8.7-bin.zip
fi

export JAVA_HOME="$TOOLCHAIN_DIR/jdk17"
export ANDROID_HOME="$TOOLCHAIN_DIR/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

if [ ! -d "$ANDROID_HOME/platforms/android-34" ] || [ ! -d "$ANDROID_HOME/build-tools/34.0.0" ]; then
  echo "== Accepting Android SDK licenses =="
  yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" --licenses > /dev/null
  echo "== Installing SDK platform-tools / platform 34 / build-tools 34.0.0 =="
  "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_HOME" \
    "platform-tools" "platforms;android-34" "build-tools;34.0.0"
fi

echo "== Building debug APK =="
cd "$PROJECT_DIR"
"$TOOLCHAIN_DIR/gradle/bin/gradle" assembleDebug --console=plain

APK_PATH="$PROJECT_DIR/app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK_PATH" ]; then
  echo
  echo "Build succeeded: $APK_PATH"
else
  echo "Build finished but APK not found at expected path: $APK_PATH" >&2
  exit 1
fi
