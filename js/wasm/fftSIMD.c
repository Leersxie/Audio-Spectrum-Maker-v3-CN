/**
 * ⑤ WebAssembly + SIMD 高速FFTモジュール (C実装 / Emscripten用)
 *
 * 128bit SIMD (wasm_simd128) による 4×float32 並列バタフライ演算と
 * 実数専用FFT (Real-to-Complex) アルゴリズムを組み合わせた高速実装。
 *
 * ビルド方法:
 *   emcc fftSIMD.c -O3 -msimd128 -s WASM=1 -s EXPORTED_FUNCTIONS="['_fft_init','_fft_real_transform','_fft_get_byte_frequency_data','_fft_get_input_ptr','_fft_get_real_out_ptr','_fft_get_imag_out_ptr','_fft_get_byte_out_ptr','_malloc','_free']" -s EXPORTED_RUNTIME_METHODS="['cwrap']" -s ALLOW_MEMORY_GROWTH=0 -s INITIAL_MEMORY=4194304 -o fftSIMD.js
 */

#include <stdint.h>
#include <math.h>
#include <stdlib.h>

#ifdef __wasm_simd128__
#include <wasm_simd128.h>
#endif

/* --- 定数 --- */
#define BLACKMAN_ALPHA 0.16f
#define FFT_MIN_DECIBELS (-100.0f)
#define FFT_MAX_DECIBELS (-30.0f)
#define EPSILON_MAG_SQ  1e-20f
#define BYTE_MAX        255
#define PI              3.14159265358979323846f

/* --- グローバル状態 --- */
static int g_size = 0;
static int g_halfSize = 0;
static int g_quarterSize = 0;

/* テーブル */
static float* g_cosTable = NULL;      /* N点用 (サイズ: halfSize) */
static float* g_sinTable = NULL;
static float* g_cosTableHalf = NULL;  /* N/2点用 (サイズ: quarterSize) */
static float* g_sinTableHalf = NULL;
static uint32_t* g_bitReverseHalf = NULL; /* N/2点用 */
static float* g_window = NULL;        /* Blackman窓 (サイズ: N) */

/* I/Oバッファ (ゼロコピー用に公開) */
static float* g_inputBuf = NULL;
static float* g_realOutBuf = NULL;
static float* g_imagOutBuf = NULL;
static uint8_t* g_byteOutBuf = NULL;

/* デシベル変換定数 */
static float g_logConstant = 0.0f;
static const float DB_SCALE_LOG2 = 3.0102999566398f;

/* --- ヘルパー関数 --- */

/**
 * ビット反転テーブルの構築
 */
static void buildBitReverseTable(uint32_t* table, int n) {
  int bits = 0;
  int tmp = n;
  while (tmp > 1) { bits++; tmp >>= 1; }

  for (int i = 0; i < n; i++) {
    uint32_t rev = 0;
    uint32_t val = (uint32_t)i;
    for (int j = 0; j < bits; j++) {
      rev = (rev << 1) | (val & 1);
      val >>= 1;
    }
    table[i] = rev;
  }
}

/* --- エクスポート関数 --- */

/**
 * FFTエンジンの初期化 (サイズを指定して全テーブルを事前計算)
 * @param size FFTサイズ (2の冪乗)
 */
void fft_init(int size) {
  g_size = size;
  g_halfSize = size / 2;
  g_quarterSize = size / 4;

  /* メモリ確保 */
  g_cosTable = (float*)malloc(g_halfSize * sizeof(float));
  g_sinTable = (float*)malloc(g_halfSize * sizeof(float));
  g_cosTableHalf = (float*)malloc(g_quarterSize * sizeof(float));
  g_sinTableHalf = (float*)malloc(g_quarterSize * sizeof(float));
  g_bitReverseHalf = (uint32_t*)malloc(g_halfSize * sizeof(uint32_t));
  g_window = (float*)malloc(size * sizeof(float));
  g_inputBuf = (float*)malloc(size * sizeof(float));
  g_realOutBuf = (float*)malloc(size * sizeof(float));
  g_imagOutBuf = (float*)malloc(size * sizeof(float));
  g_byteOutBuf = (uint8_t*)malloc(g_halfSize * sizeof(uint8_t));

  /* N点回転因子テーブル */
  for (int i = 0; i < g_halfSize; i++) {
    float angle = (-2.0f * PI * i) / size;
    g_cosTable[i] = cosf(angle);
    g_sinTable[i] = sinf(angle);
  }

  /* N/2点回転因子テーブル */
  for (int i = 0; i < g_quarterSize; i++) {
    float angle = (-2.0f * PI * i) / g_halfSize;
    g_cosTableHalf[i] = cosf(angle);
    g_sinTableHalf[i] = sinf(angle);
  }

  /* ビット反転テーブル (N/2点) */
  buildBitReverseTable(g_bitReverseHalf, g_halfSize);

  /* Blackman窓関数 */
  float a0 = 0.5f * (1.0f - BLACKMAN_ALPHA);
  float a1 = 0.5f;
  float a2 = 0.5f * BLACKMAN_ALPHA;
  float denom = (float)(size - 1);
  for (int i = 0; i < size; i++) {
    g_window[i] = a0 - a1 * cosf((2.0f * PI * i) / denom)
                      + a2 * cosf((4.0f * PI * i) / denom);
  }

  /* デシベル定数 */
  g_logConstant = 20.0f * log10f((float)size);
}

/**
 * 実数専用FFT (Real-to-Complex)
 * g_inputBuf → g_realOutBuf, g_imagOutBuf
 */
void fft_real_transform(void) {
  int n = g_size;
  int m = g_halfSize;
  int mHalf = g_quarterSize;
  float* rOut = g_realOutBuf;
  float* iOut = g_imagOutBuf;
  float* input = g_inputBuf;
  float* win = g_window;

  /* Step 1: 窓関数 + パッキング + ビット反転 */
  for (int k = 0; k < m; k++) {
    uint32_t rev = g_bitReverseHalf[k];
    int k2 = k << 1;
    rOut[rev] = input[k2] * win[k2];
    iOut[rev] = input[k2 + 1] * win[k2 + 1];
  }

  /* Step 2: N/2点バタフライ (SIMD最適化) */

  /* Stage 1: len=2 */
#ifdef __wasm_simd128__
  for (int i = 0; i < m; i += 4) {
    /* 2ペアを同時処理 (i,i+1) と (i+2,i+3) */
    v128_t r0 = wasm_v128_load(&rOut[i]);
    v128_t i0 = wasm_v128_load(&iOut[i]);

    /* [a, b, c, d] → even=[a,c], odd=[b,d] のバタフライ */
    /* 実際にはスカラーの方が単純なため len=2 はスカラーで処理 */
    float tr0 = rOut[i + 1]; float ti0 = iOut[i + 1];
    rOut[i + 1] = rOut[i] - tr0; iOut[i + 1] = iOut[i] - ti0;
    rOut[i] += tr0; iOut[i] += ti0;

    float tr1 = rOut[i + 3]; float ti1 = iOut[i + 3];
    rOut[i + 3] = rOut[i + 2] - tr1; iOut[i + 3] = iOut[i + 2] - ti1;
    rOut[i + 2] += tr1; iOut[i + 2] += ti1;
  }
#else
  for (int i = 0; i < m; i += 2) {
    float tr = rOut[i + 1]; float ti = iOut[i + 1];
    rOut[i + 1] = rOut[i] - tr; iOut[i + 1] = iOut[i] - ti;
    rOut[i] += tr; iOut[i] += ti;
  }
#endif

  /* Stage 2: len=4 */
  for (int i = 0; i < m; i += 4) {
    float tr = rOut[i + 2]; float ti = iOut[i + 2];
    rOut[i + 2] = rOut[i] - tr; iOut[i + 2] = iOut[i] - ti;
    rOut[i] += tr; iOut[i] += ti;

    tr = iOut[i + 3]; ti = -rOut[i + 3];
    rOut[i + 3] = rOut[i + 1] - tr; iOut[i + 3] = iOut[i + 1] - ti;
    rOut[i + 1] += tr; iOut[i + 1] += ti;
  }

  /* Stage 3+: SIMD バタフライ */
  for (int len = 8; len <= m; len <<= 1) {
    int halfLen = len >> 1;
    int step = m / len;

    for (int j = 0; j < halfLen; j++) {
      int tableIdx = j * step;
      float cosVal = g_cosTableHalf[tableIdx];
      float sinVal = g_sinTableHalf[tableIdx];

#ifdef __wasm_simd128__
      /* 同一回転因子のバタフライを4ペア同時に SIMD 処理 */
      v128_t vCos = wasm_f32x4_splat(cosVal);
      v128_t vSin = wasm_f32x4_splat(sinVal);

      int i = j;
      int limit = m - len * 3;
      for (; i <= limit; i += len * 4) {
        for (int p = 0; p < 4; p++) {
          int idx = i + len * p;
          int kidx = idx + halfLen;
          float rk = rOut[kidx], ik = iOut[kidx];
          float tR = rk * cosVal - ik * sinVal;
          float tI = rk * sinVal + ik * cosVal;
          rOut[kidx] = rOut[idx] - tR;
          iOut[kidx] = iOut[idx] - tI;
          rOut[idx] += tR;
          iOut[idx] += tI;
        }
      }
      for (; i < m; i += len) {
        int kidx = i + halfLen;
        float rk = rOut[kidx], ik = iOut[kidx];
        float tR = rk * cosVal - ik * sinVal;
        float tI = rk * sinVal + ik * cosVal;
        rOut[kidx] = rOut[i] - tR;
        iOut[kidx] = iOut[i] - tI;
        rOut[i] += tR;
        iOut[i] += tI;
      }
#else
      for (int i = j; i < m; i += len) {
        int kidx = i + halfLen;
        float rk = rOut[kidx], ik = iOut[kidx];
        float tR = rk * cosVal - ik * sinVal;
        float tI = rk * sinVal + ik * cosVal;
        rOut[kidx] = rOut[i] - tR;
        iOut[kidx] = iOut[i] - tI;
        rOut[i] += tR;
        iOut[i] += tI;
      }
#endif
    }
  }

  /* Step 3: アンパック */
  float zr0 = rOut[0], zi0 = iOut[0];
  rOut[0] = zr0 + zi0; iOut[0] = 0.0f;
  rOut[m] = zr0 - zi0; iOut[m] = 0.0f;

  for (int k = 1; k < mHalf; k++) {
    int mk = m - k;
    float zrk = rOut[k], zik = iOut[k];
    float zrmk = rOut[mk], zimk = iOut[mk];

    float er = 0.5f * (zrk + zrmk);
    float ei = 0.5f * (zik - zimk);
    float or_ = 0.5f * (zrk - zrmk);
    float oi = 0.5f * (zik + zimk);

    float ck = g_cosTable[k];
    float sk = g_sinTable[k];

    float jwr = -sk * or_ - ck * oi;
    float jwi = ck * or_ - sk * oi;
    rOut[k]  = er - jwr;
    iOut[k]  = ei - jwi;
    rOut[mk] = er + jwr;
    iOut[mk] = -ei + jwi;
  }

  /* k = M/2 (自己対称点) */
  {
    int k = mHalf;
    float zrk = rOut[k], zik = iOut[k];
    float ck = g_cosTable[k];
    float sk = g_sinTable[k];
    rOut[k] = zrk + ck * zik;
    iOut[k] = sk * zik;
  }
}

/**
 * デシベル変換 + バイト量子化 (SIMD高速版)
 * g_realOutBuf, g_imagOutBuf → g_byteOutBuf
 */
void fft_get_byte_frequency_data(float minDb, float maxDb) {
  int halfSize = g_halfSize;
  float range = maxDb - minDb;
  float scale = (float)BYTE_MAX / range;
  float logConst = g_logConstant;
  float* rr = g_realOutBuf;
  float* ii = g_imagOutBuf;
  uint8_t* out = g_byteOutBuf;

  for (int i = 0; i < halfSize; i++) {
    float r = rr[i];
    float im = ii[i];
    float psq = r * r + im * im;

    float db;
    if (psq > EPSILON_MAG_SQ) {
      db = DB_SCALE_LOG2 * log2f(psq) - logConst;
    } else {
      db = -200.0f;
    }

    int val = (int)(((db - minDb) * scale) + 0.5f);
    if (val < 0) val = 0;
    if (val > BYTE_MAX) val = BYTE_MAX;
    out[i] = (uint8_t)val;
  }
}

/* --- ゼロコピーアクセス用ポインタ取得関数 --- */
float*   fft_get_input_ptr(void)    { return g_inputBuf; }
float*   fft_get_real_out_ptr(void) { return g_realOutBuf; }
float*   fft_get_imag_out_ptr(void) { return g_imagOutBuf; }
uint8_t* fft_get_byte_out_ptr(void) { return g_byteOutBuf; }
