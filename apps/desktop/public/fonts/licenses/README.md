# Omni Translate 字体资产说明 (Font Assets & Licensing)

本目录包含了 Omni Translate 桌面端支持的 20 种 UI 语言对应的 Google Noto Sans 官方 Variable TTF（可变字体）原始资产及逐项许可协议。

---

## 1. 20 种 UI 语言与字体覆盖清单

根据 `apps/desktop/src/i18n/languages.ts` 中支持的 20 种语言，共配置 10 个官方 Variable TTF 文件完成无死角覆盖：

| 序号 | 语言代码 | 语言名称 | 书写系统 (Script) | 对应字形资产文件 | 推荐 font-family | 共享/独立 |
|:---:|:---|:---|:---|:---|:---|:---:|
| 1 | zh-CN | 简体中文 | Simplified Chinese (Hans) | NotoSansSC[wght].ttf | 'Noto Sans SC' | 独立 |
| 2 | en | English | Latin | NotoSans[wdth,wght].ttf | 'Noto Sans' | 共享主包 |
| 3 | es | Español | Latin | NotoSans[wdth,wght].ttf | 'Noto Sans' | 共享主包 |
| 4 | ar | العربية | Arabic (RTL) | NotoSansArabic[wdth,wght].ttf | 'Noto Sans Arabic' | 独立 |
| 5 | pt | Português | Latin | NotoSans[wdth,wght].ttf | 'Noto Sans' | 共享主包 |
| 6 | ru | Русский | Cyrillic | NotoSans[wdth,wght].ttf | 'Noto Sans' | 共享主包 |
| 7 | hi | हिन्दी | Devanagari | NotoSansDevanagari[wdth,wght].ttf | 'Noto Sans Devanagari' | 独立 (与 mr 共享) |
| 8 | bn | বাংলা | Bengali | NotoSansBengali[wdth,wght].ttf | 'Noto Sans Bengali' | 独立 |
| 9 | de | Deutsch | Latin | NotoSans[wdth,wght].ttf | 'Noto Sans' | 共享主包 |
| 10 | id | Bahasa Indonesia | Latin | NotoSans[wdth,wght].ttf | 'Noto Sans' | 共享主包 |
| 11 | ko | 한국어 | Hangul (Korean) | NotoSansKR[wght].ttf | 'Noto Sans KR' | 独立 |
| 12 | fr | Français | Latin | NotoSans[wdth,wght].ttf | 'Noto Sans' | 共享主包 |
| 13 | vi | Tiếng Việt | Latin (Vietnamese) | NotoSans[wdth,wght].ttf | 'Noto Sans' | 共享主包 |
| 14 | ja | 日本語 | Japanese (Kana/Kanji) | NotoSansJP[wght].ttf | 'Noto Sans JP' | 独立 |
| 15 | te | తెలుగు | Telugu | NotoSansTelugu[wdth,wght].ttf | 'Noto Sans Telugu' | 独立 |
| 16 | ta | தமிழ் | Tamil | NotoSansTamil[wdth,wght].ttf | 'Noto Sans Tamil' | 独立 |
| 17 | mr | मराठी | Devanagari | NotoSansDevanagari[wdth,wght].ttf | 'Noto Sans Devanagari' | 与 hi 共享 |
| 18 | th | ไทย | Thai | NotoSansThai[wdth,wght].ttf | 'Noto Sans Thai' | 独立 |
| 19 | fil | Filipino | Latin | NotoSans[wdth,wght].ttf | 'Noto Sans' | 共享主包 |
| 20 | tr | Türkçe | Latin | NotoSans[wdth,wght].ttf | 'Noto Sans' | 共享主包 |

---

## 2. 逐项官方源、Commit/Release、校验哈希 (SHA256) 与许可文件

所有字体文件均直接获取自 Google Fonts 官方发布规范，未经任何未经证实的二次转码或非官方子集化，全部符合 **SIL Open Font License, Version 1.1**。每一字体家族的官方 OFL 原文完整留存于本目录下独立文件，以完整尊重各作者版权及 Adobe 声明（Reserved Font Name 'Source'）。

| 字体资产文件名 | 字节大小 | SHA-256 校验哈希 | 上游 Git 仓库与锁定 Commit / Release | 对应独立 OFL 协议文件 |
|:---|:---:|:---|:---|:---|
| `NotoSans[wdth,wght].ttf` | 2,049,096 | `bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d` | notofonts/latin-greek-cyrillic<br>Commit: `c4a321e123e4d4ff315f57f4e0adf294fe3a95be`<br>Release: NotoSans-v2.015 | [LICENSE-NotoSans.txt](./LICENSE-NotoSans.txt) |
| `NotoSansSC[wght].ttf` | 17,772,300 | `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da` | notofonts/noto-cjk (Adobe)<br>Commit: `523d033d6cb47f4a80c58a35753646f5c3608a78` | [LICENSE-NotoSansSC.txt](./LICENSE-NotoSansSC.txt) |
| `NotoSansJP[wght].ttf` | 9,589,900 | `c2f3b4d463500a2ddcd3849cded1fceeb9fd6d1c32e6cbecd568453ba50fc68f` | notofonts/noto-cjk (Adobe)<br>Commit: `523d033d6cb47f4a80c58a35753646f5c3608a78` | [LICENSE-NotoSansJP.txt](./LICENSE-NotoSansJP.txt) |
| `NotoSansKR[wght].ttf` | 10,414,588 | `194018e6b2b293a7964f037b25c0249ce1418bc9ab3c971060a03aa57861e252` | notofonts/noto-cjk (Adobe)<br>Commit: `523d033d6cb47f4a80c58a35753646f5c3608a78` | [LICENSE-NotoSansKR.txt](./LICENSE-NotoSansKR.txt) |
| `NotoSansArabic[wdth,wght].ttf` | 844,676 | `63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e` | notofonts/arabic<br>Commit: `6c8320740db19efbb3127c3697b0ee5d0fa62319`<br>Release: NotoSansArabic-v2.012 | [LICENSE-NotoSansArabic.txt](./LICENSE-NotoSansArabic.txt) |
| `NotoSansDevanagari[wdth,wght].ttf` | 641,944 | `14ec4af41f27482216d1c2229f417ff9b1425e1babb014e57d1d40d03229853e` | notofonts/devanagari<br>Commit: `e123d230c160ebe949d731cc19017cdb354180d1`<br>Release: NotoSansDevanagari-v2.007 | [LICENSE-NotoSansDevanagari.txt](./LICENSE-NotoSansDevanagari.txt) |
| `NotoSansBengali[wdth,wght].ttf` | 463,668 | `dcd42978094e584a849c84a51450eeac40c8826057d566ea6d4b9627a403a05a` | notofonts/bengali<br>Commit: `85d80394cbbbb798ca0a41c983902e6cf77be3a3`<br>Release: NotoSansBengali-v3.011 | [LICENSE-NotoSansBengali.txt](./LICENSE-NotoSansBengali.txt) |
| `NotoSansTelugu[wdth,wght].ttf` | 888,808 | `e618af7bf999df192ed4f388eba2e563f2b5015034e9cbb317b5bd793bd7334d` | notofonts/telugu<br>Commit: `af5b949ed1906ead47608577d092fb013d3145d3`<br>Release: NotoSansTelugu-v2.005 | [LICENSE-NotoSansTelugu.txt](./LICENSE-NotoSansTelugu.txt) |
| `NotoSansTamil[wdth,wght].ttf` | 340,668 | `aa3a9b321f4b0bb2c40203ffbde9af89713227866e0e13f76e5b9eeea727cf88` | notofonts/tamil<br>Commit: `626575fa0c68c81dee17a0342003c08c0ab8375e`<br>Release: NotoSansTamil-v2.004 | [LICENSE-NotoSansTamil.txt](./LICENSE-NotoSansTamil.txt) |
| `NotoSansThai[wdth,wght].ttf` | 218,652 | `5a1c559bb539583c8a1fd99d1c5b9491e5e14478c9cd2bd0970d5c3096cc9ef8` | notofonts/thai<br>Commit: `f8f3f024703f9d939d02f4e2fe16f1d5a39ca963`<br>Release: NotoSansThai-v2.002 | [LICENSE-NotoSansThai.txt](./LICENSE-NotoSansThai.txt) |

---

## 3. 版权与保留名称特别声明 (Reserved Font Name)

- **CJK 系列 (Noto Sans SC, JP, KR)**:
  - 版权所有: Copyright 2014-2021 Adobe (http://www.adobe.com/)
  - 保留字形名称: with Reserved Font Name 'Source'
  - 授权条款: SIL Open Font License, Version 1.1 全文详见 [LICENSE-NotoSansSC.txt](./LICENSE-NotoSansSC.txt)、[LICENSE-NotoSansJP.txt](./LICENSE-NotoSansJP.txt)、[LICENSE-NotoSansKR.txt](./LICENSE-NotoSansKR.txt)。
- **非 CJK 系列 (Latin, Arabic, Devanagari, Bengali, Telugu, Tamil, Thai)**:
  - 版权所有: Copyright 2022 The Noto Project Authors (各语言上游仓库地址详见上表)
  - 授权条款: SIL Open Font License, Version 1.1 全文详见各自对应 LICENSE-*.txt 文件。

---

## 4. CSS 声明使用

直接在工程样式中引入同目录的 `fonts.css`：

```css
@import "./assets/fonts/fonts.css";

/* 使用推荐的全局回退栈 */
body {
  font-family: var(--font-family-sans);
}
```