#!/bin/bash
# fftSIMD.wasm ビルドスクリプト
# 前提条件: Emscripten SDK (emsdk) がインストール済みで、emcc にパスが通っていること
#
# インストール方法:
#   git clone https://github.com/emscripten-core/emsdk.git
#   cd emsdk
#   ./emsdk install latest
#   ./emsdk activate latest
#   source ./emsdk_env.sh
#
# 使用方法:
#   cd js/wasm/
#   bash build.sh

set -e

echo "=== fftSIMD.wasm ビルド開始 ==="

emcc fftSIMD.c \
  -O3 \
  -msimd128 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS="['_fft_init','_fft_real_transform','_fft_get_byte_frequency_data','_fft_get_input_ptr','_fft_get_real_out_ptr','_fft_get_imag_out_ptr','_fft_get_byte_out_ptr','_malloc','_free']" \
  -s EXPORTED_RUNTIME_METHODS="['cwrap']" \
  -s ALLOW_MEMORY_GROWTH=0 \
  -s INITIAL_MEMORY=4194304 \
  -s ENVIRONMENT='web,worker' \
  -s MODULARIZE=1 \
  -s EXPORT_NAME='createFFTModule' \
  -o fftSIMD.js

echo "=== ビルド完了: fftSIMD.js + fftSIMD.wasm ==="
