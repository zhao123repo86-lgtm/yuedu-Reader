#!/bin/bash
# 阅 · Reader — APK 构建脚本（无 Gradle，纯 aapt2 + javac + d8 + apksigner）
set -euo pipefail

PROJ="$(cd "$(dirname "$0")" && pwd)"
JDK="$HOME/toolchain/jdk-17.0.21+9/Contents/Home"
BT="$HOME/Library/Android/sdk/build-tools/36.1.0"
AJ="$HOME/toolchain/sdk-platform/android-36/android.jar"
JAVA="$JDK/bin/java"
JAVAC="$JDK/bin/javac"
KEYTOOL="$JDK/bin/keytool"

export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$PATH"

NAME="yue-reader"
VER="1.0"
OUT="$PROJ/build"

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/gen"

echo "▸ 1/7 编译资源"
"$BT/aapt2" compile --dir "$PROJ/res" -o "$OUT/compiled.zip"

echo "▸ 2/7 链接 APK（含 assets）"
"$BT/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$AJ" \
  --manifest "$PROJ/AndroidManifest.xml" \
  -A "$PROJ/assets" \
  --java "$OUT/gen" \
  --auto-add-overlay \
  --no-version-vectors \
  "$OUT/compiled.zip"

echo "▸ 3/7 编译 Java"
"$JAVAC" -encoding UTF-8 -source 8 -target 8 \
  -bootclasspath "$AJ" -classpath "$AJ:$BT/core-lambda-stubs.jar" \
  -d "$OUT/classes" \
  $(find "$PROJ/src" "$OUT/gen" -name '*.java')

echo "▸ 4/7 生成 dex"
"$BT/d8" --lib "$AJ" --min-api 23 --release \
  --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

echo "▸ 5/7 打包 dex + assets"
cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q -X "$OUT/unsigned.apk" classes.dex)

echo "▸ 6/7 对齐"
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo "▸ 7/7 签名"
KS="$PROJ/keystore.jks"
if [ ! -f "$KS" ]; then
  "$KEYTOOL" -genkeypair -v \
    -keystore "$KS" -storepass yue2026 -keypass yue2026 \
    -alias yue -keyalg RSA -keysize 2048 -validity 10950 \
    -dname "CN=Yue Reader, OU=Personal, O=Yue, L=Shanghai, C=CN" >/dev/null 2>&1
  echo "   已生成自签证书 keystore.jks"
fi

"$BT/apksigner" sign \
  --ks "$KS" --ks-pass pass:yue2026 --key-pass pass:yue2026 \
  --ks-key-alias yue \
  --out "$PROJ/${NAME}-${VER}.apk" \
  "$OUT/aligned.apk"

"$BT/apksigner" verify --print-certs "$PROJ/${NAME}-${VER}.apk" | head -5

echo
echo "✅ 产物: $PROJ/${NAME}-${VER}.apk  ($(du -h "$PROJ/${NAME}-${VER}.apk" | cut -f1))"
"$BT/aapt2" dump badging "$PROJ/${NAME}-${VER}.apk" | head -6
