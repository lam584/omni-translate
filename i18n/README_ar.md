# Omni Translate

<h4 align="center">
    <p>
        <a href="../README.md">简体中文</a> |
        <a href="README_en.md">English</a> |
        <a href="README_es.md">Español</a> |
        <b>العربية</b> |
        <a href="README_pt.md">Português</a> |
        <a href="README_ru.md">Русский</a> |
        <a href="README_hi.md">हिन्दी</a> |
        <a href="README_bn.md">বাংলা</a> |
        <a href="README_de.md">Deutsch</a> |
        <a href="README_id.md">Bahasa Indonesia</a> |
        <a href="README_ko.md">한국어</a> |
        <a href="README_fr.md">Français</a> |
        <a href="README_vi.md">Tiếng Việt</a> |
        <a href="README_ja.md">日本語</a> |
        <a href="README_te.md">తెలుగు</a> |
        <a href="README_ta.md">தமிழ்</a> |
        <a href="README_mr.md">मराठी</a> |
        <a href="README_th.md">ไทย</a> |
        <a href="README_fil.md">Filipino</a> |
        <a href="README_tr.md">Türkçe</a>
    </p>
</h4>

Omni Translate هو تطبيق سطح مكتب لنظام Windows مخصص لترجمة الصوت في الوقت الفعلي. يستهدف سير عمل مثل ترجمة ترجمات الفيديو، وترجمة صوت الألعاب، والترجمة الصوتية ثنائية الاتجاه في غرف الصوت أو الاجتماعات. يربط التطبيق برنامج تشغيل صوت افتراضي وNative Bridge وRust Core Runtime وAI Gateway موحدة لمعالجة التقاط الصوت وASR وترجمة LLM وTTS وعرض الترجمة وتوجيه التشغيل.

## الميزات

- **ترجمة ترجمات فورية**: يلتقط صوت النظام أو الميكروفون، ويتعرف على الكلام، ويعرض الترجمات المترجمة في النافذة الرئيسية والنافذة العائمة.
- **نافذة ترجمات عائمة**: نافذة مستقلة شفافة بلا إطار وتبقى دائما في الأعلى، ومصممة للظهور فوق الفيديو أو الألعاب أو تطبيقات الاجتماعات.
- **ترجمة صوتية ثنائية الاتجاه**: تدعم أوضاع التوجيه للمشاهدة والألعاب وغرف الصوت، وتشمل الترجمة/الصوت الوارد وإخراج الميكروفون الافتراضي الصادر.
- **برنامج تشغيل صوت افتراضي**: برنامج تشغيل صوت افتراضي لنظام Windows مبني على SYSVAD WaveRT ويتصل بخدمة الجسر في وضع المستخدم عبر IOCTL وABI مشتركة.
- **Rust Native Bridge**: يمثل `apps/bridge-service-native` تنفيذ الجسر الإنتاجي الوحيد حاليا، ويتولى WASAPI وNamed Pipe IPC وإطارات الصوت والتفاعل مع برنامج التشغيل.
- **AI Gateway موحدة**: تكامل قائم على القوالب مع DashScope والواجهات المتوافقة مع OpenAI، مع دعم HTTP وstreaming HTTP وWebSocket.
- **إدارة المصطلحات**: تدعم استيراد حزم مصطلحات المجالات وتصديرها ودمجها وسياسات الأولوية، ثم حقنها في مسار مطالبات الترجمة.
- **إدارة آمنة لبيانات الاعتماد**: يتم حفظ API Key والمعلومات الحساسة الأخرى في Windows Credential Manager بدلا من كتابتها كنص صريح في إعدادات العمل.
- **التشخيص وبوابات الجودة**: توفر فحص صحة برنامج التشغيل، وTrace للنماذج، وتصدير السجلات، واختبارات Watch Mode للمسار الحقيقي، وبوابات جودة ما قبل الإصدار.
- **20 لغة للواجهة**: تغطي موارد الواجهة الحالية `ar` و`bn` و`de` و`en` و`es` و`fil` و`fr` و`hi` و`id` و`ja` و`ko` و`mr` و`pt` و`ru` و`ta` و`te` و`th` و`tr` و`vi` و`zh-CN`.

## البدء السريع

### المتطلبات

- **Node.js** >= 20
- **Rust stable**، edition 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**، مطلوب فقط عند بناء برنامج تشغيل الصوت الافتراضي
- يتطلب تحميل برنامج تشغيل التطوير وضع Windows TESTSIGNING؛ ولا تحتاج معاينة الواجهة الأمامية العادية إلى برنامج التشغيل أو صلاحيات المسؤول

### التثبيت والتشغيل

```bash
# 1. استنساخ المستودع
git clone <repo-url>
cd omni-translate

# 2. تثبيت الاعتماديات
npm install

# 3. بدء معاينة الواجهة الأمامية في المتصفح
npm run dev:desktop

# 4. بدء تطبيق Tauri المكتبي الكامل
npm run dev:desktop-shell
```

يستخدم وضع معاينة المتصفح Mock runtime تلقائيا، لذلك يناسب تطوير الواجهة وفحص الصفحات. يبدأ تطبيق سطح المكتب الكامل Tauri/Rust runtime، ولا يطلق مسار رفع الصلاحيات إلا عند تنفيذ إجراءات مثل تثبيت برنامج التشغيل أو إصلاحه.

### الأوامر الشائعة

| الأمر | الوصف |
| --- | --- |
| `npm run dev:desktop` | بدء خادم تطوير واجهة React/Vite الأمامية |
| `npm run dev:desktop-shell` | بدء تطبيق Tauri المكتبي الكامل عبر سكربت رفع الصلاحيات |
| `npm run lint:desktop` | تشغيل ESLint للواجهة الأمامية المكتبية |
| `npm run check:desktop` | تشغيل فحص أنواع TypeScript |
| `npm run build:desktop` | بناء أصول الواجهة الأمامية |
| `npm run check:desktop-shell` | فحص خلفية Tauri Rust |
| `npm run build:desktop-shell` | بناء تطبيق Tauri الكامل |
| `npm run build:bridge-service-native` | بناء Rust Native Bridge Service |
| `npm run test:all` | تشغيل مدخل الاختبارات الكامل |
| `npm run test:contracts` | التحقق من العقود المجمدة |
| `npm run test:watch-mode-live:dry-run` | تشغيل dry-run لمسار Watch Mode الحقيقي |
| `npm run quality:gate:auto` | تشغيل بوابة الجودة الآلية |
| `npm run quality:gate:release` | تشغيل بوابة جودة الإصدار |
| `npm run driver:build-sysvad` | بناء برنامج تشغيل الصوت الافتراضي SYSVAD |
| `npm run driver:install` | تثبيت برنامج تشغيل التطوير |
| `npm run driver:test` | فحص حالة برنامج تشغيل التطوير |
| `npm run driver:uninstall` | إلغاء تثبيت برنامج تشغيل التطوير |
| `npm run release:prepare` | تشغيل مسار التحضير للإصدار |

## بنية النظام

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    النافذة الرئيسية، نافذة الترجمة العائمة، التوجيه،         │
│    الإعدادات، التشخيص، صفحات Provider                       │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    أوامر/أحداث Tauri، تنسيق الجلسات، تخزين الإعدادات،        │
│    التشخيص، تكامل علبة النظام                               │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio، التقاط صوت النظام/الميكروفون،     │
│    VAD، التقسيم، المزج                                      │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite، موفرو ASR / Translation / TTS      │
│    قوالب DashScope والواجهات المتوافقة مع OpenAI،            │
│    فحص القدرات، توحيد الأخطاء                               │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar، WASAPI، Named Pipe IPC، إطارات الصوت،       │
│    IOCTL لبرنامج التشغيل                                    │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    برنامج تشغيل صوت افتراضي SYSVAD WaveRT، التثبيت،          │
│    التراجع، الإصلاح وفحص الصحة                              │
└────────────────────────────────────────────────────────────┘
```

## بنية المجلدات

```text
omni-translate/
├── apps/
│   ├── desktop/                    # تطبيق Tauri المكتبي
│   │   ├── src/                    # واجهة React الأمامية
│   │   │   ├── components/         # مكونات UI مشتركة
│   │   │   ├── i18n/               # موارد 20 لغة للواجهة
│   │   │   ├── pages/              # صفحات الجلسة والتوجيه وProvider والمصطلحات والإعدادات والتشخيص
│   │   │   ├── runtime/            # طبقة تكييف runtime/IPC للواجهة الأمامية
│   │   │   ├── schema/             # عقود وأنواع TypeScript
│   │   │   └── stores/             # حالة Zustand
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # محرك الصوت، STT، TTS، توجيه الترجمة، Providers فوريون
│   │           ├── bridge/         # تثبيت Bridge/driver وعقود IPC
│   │           ├── diagnostics/    # السجلات، Trace، حالة التشخيص
│   │           ├── provider/       # AI Gateway، قوالب Provider، نقل HTTP/WS
│   │           ├── runtime/        # النوافذ، علبة النظام، حالة runtime
│   │           └── storage/        # مستودع SQLite ومعالجة بيانات الاعتماد
│   └── bridge-service-native/      # Rust Native Bridge Service، تنفيذ الجسر الإنتاجي الوحيد
├── drivers/
│   └── windows-virtual-mic/        # برنامج تشغيل صوت افتراضي SYSVAD WaveRT
│       ├── include/                # ABI مشتركة بين Driver/Bridge لـ IOCTL
│       ├── package/                # بيانات وصفية لحزمة برنامج التشغيل
│       └── sysvad/                 # مصدر برنامج التشغيل المعدل من مثال Microsoft SYSVAD
├── scripts/
│   ├── development/                # سكربتات بدء التطوير
│   ├── diagnostics/                # أدوات التشخيص
│   ├── installer/                  # بناء برنامج التشغيل وتثبيته وإزالته وإصلاحه وفحصه
│   ├── release/                    # تحقق الإصدار وmanifest والتغليف وقائمة التوقيع
│   └── testing/                    # الاختبارات والتغطية وبوابات الجودة ومسارات Watch Mode
├── docs/                           # وثائق البنية والجودة والمشروع ومراجع Provider/API
└── artifacts/                      # مخرجات البناء والسجلات ومخرجات التشخيص
```

## التدفقات الأساسية

### الترجمة الواردة (سيناريوهات المشاهدة/الترجمات)

```text
صوت النظام
  → برنامج تشغيل صوت افتراضي / التقاط WASAPI
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / التقسيم
  → ASR
  → Translation Provider
  → عرض الترجمة (النافذة الرئيسية + النافذة العائمة)
  → TTS اختياري
  → مكبر الصوت المحلي / خرج المراقبة
```

### الترجمة الصادرة (سيناريوهات غرفة الصوت/الاجتماع/اللعبة)

```text
الميكروفون
  → Desktop Rust Audio Layer
  → VAD / التقسيم
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → برنامج تشغيل صوت افتراضي
  → يقرأ التطبيق الهدف الميكروفون الافتراضي / نقطة النهاية الافتراضية
```

### زمن الاستجابة وأوضاع التدهور

- الترجمات والصوت المدبلج نتيجتان مستقلتان للجدولة؛ يتم تثبيت الترجمات أولا.
- عندما يتجاوز زمن استجابة Provider الميزانية، يتم إصدار `latency-high`، وتستمر الترجمات، وينتقل TTS إلى حالة deferred/queued.
- عندما يحدد فحص Provider أنه غير مناسب للاستخدام الفوري، يتم تعطيل الصوت المدبلج افتراضيا ويبقى مسار أولوية الترجمة نشطا.
- لا تمنع أعطال برنامج التشغيل أو Bridge بدء التطبيق؛ يجب أن تبقى الترجمات والتشغيل المحلي وصفحات التشخيص متاحة في وضع التدهور.

## المكدس التقني

| الطبقة | التقنية |
| --- | --- |
| الواجهة الأمامية | React 19.2.x، TypeScript 6.0.x، Vite 8.x، Rolldown، CSS |
| غلاف سطح المكتب | Tauri 2.x، `@tauri-apps/api`، `@tauri-apps/cli` |
| الحالة والتوجيه | Zustand 5.x، react-router-dom 7.x |
| التدويل | i18next 26.x، react-i18next 17.x، i18next-browser-languagedetector |
| اختبارات الواجهة الأمامية | Vitest 4.x، jsdom 29.x، ESLint 10.x |
| Rust runtime | Rust 2021، Serde، أوامر/أحداث Tauri |
| شبكة Provider | reqwest 0.13، tungstenite 0.29، rustls |
| التخزين وبيانات الاعتماد | rusqlite 0.40 مع SQLite مدمج، keyring 4، Windows Credential Manager |
| الصوت | cpal 0.17، rodio 0.22، wasapi 0.23، hound، minimp3 |
| واجهات النظام | windows-sys 0.61 |
| Native Bridge | Rust sidecar، WASAPI، Named Pipe، IOCTL ABI |
| برنامج التشغيل | برنامج تشغيل صوت افتراضي Windows SYSVAD WaveRT |
| السكربتات | PowerShell، سكربتات Node.js للإصدار/الاختبار |

## العقود وحدود البيانات

يحافظ المشروع حاليا على أربع مناطق عقود مجمدة:

1. **Provider Contract**: بيانات Provider الوصفية، مراجع المصادقة، معاملات الطلب، أحداث البث، بنى الأخطاء ونتائج فحص القدرات.
2. **Audio Contract**: صوت النظام، الميكروفون، إطارات PCM، التقسيم، المزج، تعويض زمن الاستجابة وحالة push-to-talk.
3. **Driver Bridge Contract**: بروتوكول التهيئة وإطارات الصوت واستعلامات الحالة وأحداث الأخطاء والإغلاق بين Desktop وNative Bridge وبرنامج التشغيل.
4. **OBS Integration Contract**: حدود الاتصال والإخراج المحجوزة لدعم لاحق لترجمة OBS العائمة ومشغلات المشاهد.

تستخدم الإعدادات المهيكلة SQLite كمصدر الحقيقة الأساسي. تحفظ بيانات الاعتماد الحساسة في Windows Credential Manager. يتم فصل السجلات والذاكرة المؤقتة وحزم المصطلحات وملفات الصوت المؤقتة حسب المجلدات.

## الجودة والاختبارات

- `npm run verify:desktop`: lint وtypecheck وtest وbuild للواجهة الأمامية المكتبية.
- `npm run test:desktop-shell`: اختبارات خلفية Tauri Rust.
- `npm run test:bridge-service-native`: اختبارات Rust الخاصة بـ Native Bridge.
- `npm run test:contracts`: التحقق من العقود المجمدة على جانب TypeScript/Rust/السكربتات.
- `npm run quality:gate:auto`: بوابة الجودة الآلية.
- `npm run quality:gate:release`: بوابة جودة الإصدار مع مداخل تحقق يدوية.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: تقارير Watch Mode والأدلة ومداخل اختبار المسار الحقيقي.

## التطوير

### تطوير الواجهة الأمامية

استخدم `npm run dev:desktop` لتطوير الواجهة الأمامية في المتصفح. في بيئات غير Tauri، ترجع طبقة runtime بيانات Mock لتسهيل فحص الصفحات والتفاعلات دون تثبيت برنامج التشغيل أو بدء خلفية Rust.

### Rust Desktop Shell

```bash
npm run check:desktop-shell
npm run test:desktop-shell
npm run build:desktop-shell
```

### Native Bridge

```bash
npm run check:bridge-service-native
npm run test:bridge-service-native
npm run build:bridge-service-native
```

### تطوير برنامج التشغيل

يتطلب بناء برنامج التشغيل Visual Studio 2022 + WDK. ويتطلب تثبيت برنامج تشغيل التطوير صلاحيات المسؤول ووضع TESTSIGNING.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## الترخيص

هذا المشروع مرخص ترخيصا خاصا. جميع الحقوق محفوظة.
