# YouTube Subtitle Translator (YT ViSub)

Tài liệu kỹ thuật và hướng dẫn sử dụng tiện ích mở rộng dịch phụ đề YouTube sang Tiếng Việt.

---

## 1. Tổng quan dự án

YT ViSub là tiện ích mở rộng trình duyệt (chuẩn Google Chrome Manifest V3) được thiết kế để tự động biên dịch phụ đề video trên nền tảng YouTube sang Tiếng Việt theo thời gian thực với kiến trúc đa máy chủ dịch thuật miễn phí (Multi-Engine Architecture).

Dự án tập trung vào các tiêu chí kỹ thuật:
- Đa dạng dịch vụ dịch thuật: Tích hợp Google Gemini AI (mô hình ngôn ngữ lớn), YouTube Native Subtitle Translation (máy chủ dịch phụ đề chính thức của YouTube), Google Translate API tốc độ cao, MyMemory Translation Memory API, và Google Cloud Translation API.
- Hiển thị phụ đề theo đúng quy chuẩn giao diện gốc (Native YouTube Caption Styling): thống nhất trên một khối nền đen mờ bán trong suốt, ôm trọn các dòng phụ đề cân đối, không viền rời rạc.
- Đồng bộ hiển thị tức thời (Atomic Synchronization): dòng phụ đề gốc và dòng biên dịch Tiếng Việt xuất hiện cùng lúc trong một khung hình duy nhất, triệt tiêu độ trễ giữa hai ngôn ngữ.
- Giao diện quản trị hiện đại (Better Lyrics Inspired Design): giao diện thẻ chia tab tiện ích, tích hợp bảng đo đạc thông số bộ nhớ đệm và xem trước trực quan.

---

## 2. Các dịch vụ dịch thuật hỗ trợ

Hệ thống cho phép người dùng linh hoạt lựa chọn giữa các máy chủ dịch thuật miễn phí:

### 2.1. Google Translate (Mặc định)
- Phương thức: Google Translate Web API qua các cụm máy chủ gtx và dict-chrome-ex.
- Đặc điểm: Tốc độ phản hồi cao (100ms - 250ms), tự động nhận diện ngôn ngữ nguồn, độ bao phủ từ vựng phong phú.

### 2.2. YouTube Native Subtitles (Chuyên dụng cho YouTube)
- Phương thức: Đánh chặn và trích xuất luồng phụ đề gốc thông qua endpoint /api/timedtext của máy chủ YouTube với cờ tham số tlang.
- Đặc điểm: Được Google và YouTube tối ưu hóa riêng cho cấu trúc phụ đề video, dịch trước toàn bộ transcript của video theo ngữ cảnh xuyên suốt, thời gian phản hồi 0ms tại từng mốc thời gian phát.

### 2.3. Google Gemini AI (Biên dịch tự nhiên và ngữ cảnh thông minh)
- Phương thức: Kết nối trực tiếp tới mô hình ngôn ngữ lớn Google Gemini (mặc định Gemini 3.5 Flash-Lite siêu nhanh, độ trễ cực thấp; hỗ trợ Gemini 3.5 Flash) thông qua API Key miễn phí từ Google AI Studio.
- Hệ thống nhận diện thể loại thích ứng (Genre-Adaptive Intelligence):
  - **Lời bài hát / Âm nhạc (Lyrics & Music):** Tự động nhận diện video âm nhạc (qua tiêu đề MV/Lyrics/Official Music Video và ký hiệu nốt nhạc `♪`, `♫`). Biên dịch giàu cảm xúc, có chất thơ và nhịp điệu (rhythmic & poetic flow), giữ nguyên các ký hiệu nốt nhạc `♪` / `♫`, dịch theo khổ đoạn để đảm bảo vần điệu xuyên suốt.
  - **Báo chí & Phóng sự (News & Documentaries):** Văn phong báo chí chuẩn mực, khách quan, trang trọng, mạch lạc, thuật ngữ tin tức chính xác.
  - **Hội thoại đời thường & Vlogs:** Văn phong tự nhiên, gần gũi, dí dỏm, đại từ nhân xưng linh hoạt phù hợp sắc thái giao tiếp.
  - **Tự động tra cứu danh tính nghệ sĩ & Chuẩn hóa vai vế (Artist Identification & Pronoun Alignment):**
    - Trích xuất chính xác tên nghệ sĩ (`Artist`) và tên bài hát (`Song`) từ siêu dữ liệu chính thức của YouTube (`ytd-metadata-row-renderer`), cấu trúc tiêu đề `Artist - Song`, và tên kênh phát.
    - Kết hợp từ điển nhận diện nghệ sĩ mở rộng (US-UK, K-Pop, J-Pop, V-Pop, Indie) và cơ chế tra cứu tri thức trực tiếp của Gemini để xác định giới tính ca sĩ (ví dụ: Laufey, Aimer, Taylor Swift là Nữ -> xưng "Em - Anh"; Keshi, Joji, Fujii Kaze là Nam -> xưng "Anh - Em").
    - Triệt tiêu hoàn toàn hiện tượng nhảy ngôi xưng hỗn loạn (*lúc tôi, lúc mình, lúc em/anh*) bằng quy tắc cấm dùng đại từ lệch pha xuyên suốt toàn bộ bài hát.
    - Hỗ trợ bộ chọn chủ động trong cài đặt (`Tự động theo ca sĩ`, `Nữ hát: Em - Anh`, `Nam hát: Anh - Em`, `Trung tính: Tôi - Bạn`).
  - **Tự động nhận diện (Auto-detect):** Dựa vào tiêu đề video và tín hiệu phụ đề để tự động chuyển phong cách dịch tối ưu mà người dùng không cần thao tác thủ công.
- Cơ chế hiệu năng cao: Tích hợp cơ chế dịch trước theo khối (Batch Pre-translation 15 câu/lần), bộ lọc chống rung câu thoại, hiển thị song ngữ tức thì 0ms, và tự động chuyển đổi dự phòng thông minh (Gemini 3.5 Flash-Lite -> Gemini 3.5 Flash -> Google Translate) khi mất kết nối mạng hoặc chạm giới hạn hạn ngạch.

### 2.4. MyMemory Translated (Dịch thuật ngữ cảnh phân tán)
- Phương thức: Tích hợp cơ sở dữ liệu bộ nhớ dịch thuật phân tán MyMemory Translated API kết hợp thuật toán tự động nhận diện hệ chữ viết (Script Detection) và chuyển đổi dự phòng.
- Đặc điểm: Phù hợp với ngôn ngữ hội thoại tự nhiên, lời bài hát và các đoạn đàm thoại đời thường.

### 2.5. Google Cloud Translation API (Tùy chọn doanh nghiệp)
- Phương thức: Kết nối trực tiếp tới Google Cloud Translation API v2 thông qua khóa API Key cá nhân của người dùng.

---

## 3. Kiến trúc kỹ thuật và cơ chế hoạt động

### 3.1. Main World Interceptor (inject.js)
- Thực thi trong môi trường trang chính (Main Execution Context) ngay từ giai đoạn khởi tạo tài liệu (document_start).
- Giám sát các yêu cầu mạng XMLHttpRequest và Fetch liên quan đến endpoint /api/timedtext của YouTube.
- Tự động phát hiện các bản nhạc phụ đề (caption tracks) của trình phát video, yêu cầu phiên bản biên dịch tlang tương ứng và chuyển tiếp dữ liệu transcript về Content Script qua cơ chế window.postMessage.

### 3.2. Content Script Engine (content.js)
- Bộ đệm đồng bộ cục bộ (Local Synchronous Cache): Lưu trữ kết quả biên dịch trong bộ nhớ RAM, cho phép truy xuất kết quả trong 0ms khi các câu thoại lặp lại hoặc khi người dùng tua video.
- Cơ chế dịch trước theo khối (Batch Pre-translation): Khi nhận được dữ liệu phụ đề từ inject.js, hệ thống tự động gom các câu thoại thành từng nhóm (batch) và dịch trước trong nền.
- Kết xuất đồng bộ (Atomic Render): Khi có thay đổi phụ đề, hệ thống chỉ hiển thị khi cả hai dòng (gốc và dịch) đã sẵn sàng, đảm bảo tính nhất quán tuyệt đối về mặt thị giác.
- Quản lý hủy yêu cầu (AbortController): Tự động hủy các phiên dịch mạng chưa hoàn thành của câu thoại trước khi người dùng chuyển sang câu thoại mới hoặc thay đổi mốc thời gian.

### 3.3. Background Service Worker (background.js)
- Đóng vai trò lớp dịch vụ dự phòng và lưu trữ cấu hình tiện ích qua chrome.storage.sync.
- Hỗ trợ cơ chế chuyển đổi dự phòng (failover) giữa các endpoint công khai của Google Translate, đồng thời quản lý các yêu cầu dịch thuật MyMemory và Google Cloud.

### 3.4. Giao diện điều khiển (popup/)
- Cung cấp giao diện cấu hình chế độ hiển thị (Song ngữ hoặc Đơn ngữ Tiếng Việt), lựa chọn dịch vụ dịch thuật, cỡ chữ, độ mờ nền, màu sắc và quản lý bộ nhớ đệm.

---

## 4. Hướng dẫn cài đặt

Áp dụng cho các trình duyệt phát triển trên nền Chromium (Google Chrome, Microsoft Edge, Brave, Cốc Cốc):

1. Mở trình duyệt và truy cập trang quản lý tiện ích:
   chrome://extensions/

2. Kích hoạt tùy chọn Chế độ dành cho nhà phát triển (Developer mode) tại góc trên bên phải.

3. Nhấp vào nút Tải tiện ích đã giải nén (Load unpacked).

4. Trỏ tới thư mục mã nguồn:
   E:\Coding\YTSubTranslateExtension

5. Xác nhận lựa chọn. Tiện ích sẽ được nạp và kích hoạt ngay lập tức.

---

## 5. Cơ chế Cập nhật qua GitHub Releases

Tiện ích tích hợp sẵn cơ chế kiểm tra và cập nhật ứng dụng tự động qua GitHub Releases API:

### 5.1. Tab Cập nhật trong Popup (Trực quan & Thuận tiện)
- **Kiểm tra tự động:** Mỗi khi mở popup, tiện ích sẽ kết nối tới GitHub Releases API (`https://api.github.com/repos/NgocThachTN/YTSubTranslateExtension/releases/latest`) để so sánh phiên bản đang cài đặt với phiên bản mới nhất trên GitHub.
- **Thông báo phiên bản mới:** Nếu phát hiện phiên bản mới hơn, tab "Cập nhật" sẽ hiển thị chấm đỏ thông báo và nút **Tải bản mới (.zip)** trực tiếp từ Release Assets.
- **Xem ghi chú thay đổi (Changelog):** Hiển thị chi tiết nội dung cập nhật, tính năng mới và ngày phát hành của phiên bản.
- **Quy trình 3 bước cập nhật:**
  1. Bấm nút **Tải bản mới (.zip)** về máy tính.
  2. Giải nén file `.zip` và chép đè vào thư mục tiện ích hiện tại.
  3. Mở `chrome://extensions/` và bấm nút **Tải lại ↻ (Reload)** tại tiện ích.

### 5.2. Cách đóng gói và phát hành (Release) lên GitHub

Dự án cung cấp 2 phương thức phát hành bản mới:

#### Cách 1: Tự động qua GitHub Actions (Khuyên dùng)
Dự án đã tích hợp sẵn GitHub Actions workflow (`.github/workflows/release.yml`). Khi bạn đẩy tag phiên bản mới lên GitHub:
```bash
git tag v1.4.0
git push origin v1.4.0
```
GitHub Actions sẽ tự động:
- Kiểm tra mã nguồn và chạy Node.js đóng gói.
- Tạo file nén chuẩn `YTSubTranslateExtension-v1.4.0.zip` (loại bỏ tệp rác, `.git`, `node_modules`).
- Tự động xuất bản GitHub Release với tag tương ứng kèm tệp `.zip` đính kèm.

#### Cách 2: Đóng gói thủ công bằng kịch bản Node.js
Nếu muốn đóng gói ngay trên máy tính mà không cần qua CI/CD:
```bash
node package-release.js
```
Kịch bản sẽ tự động trích xuất phiên bản từ `manifest.json` và tạo tệp `.zip` hoàn chỉnh tại thư mục `dist/` (ví dụ: `dist/YTSubTranslateExtension-v1.4.0.zip`). Bạn chỉ cần mở trang GitHub Releases và tải tệp này lên:
`https://github.com/NgocThachTN/YTSubTranslateExtension/releases/new`

---

## 6. Hướng dẫn sử dụng

1. Truy cập video bất kỳ trên YouTube có hỗ trợ phụ đề.
2. Bật nút Phụ đề (CC) trên trình điều khiển của YouTube nếu chưa được bật.
3. Bản dịch Tiếng Việt sẽ tự động xuất hiện cùng lúc với phụ đề gốc theo đúng giao diện chuẩn của YouTube.
4. Người dùng có thể nhấp chuột trái và kéo thả trực tiếp khối phụ đề trên màn hình video để thay đổi vị trí theo phương dọc.
5. Để tùy chỉnh thông số (cỡ chữ, độ mờ nền, đổi dịch vụ dịch thuật, kiểm tra cập nhật), nhấp vào biểu tượng tiện ích trên thanh công cụ của trình duyệt.

---

## 7. Cấu trúc thư mục

```text
YTSubTranslateExtension/
├── manifest.json              # Tệp khai báo cấu hình Manifest V3
├── inject.js                  # Script chạy trong Main World đánh chặn dữ liệu phụ đề
├── background.js               # Service Worker xử lý đa dịch vụ và bộ nhớ đệm
├── content.js                  # Engine điều phối hiển thị và xử lý phụ đề tại trang
├── content.css                 # Định dạng kiểu dáng phụ đề chuẩn YouTube
├── popup/
│   ├── popup.html              # Giao diện cài đặt đa tab phong cách Better Lyrics
│   ├── popup.css               # Định dạng giao diện và các thẻ trạng thái cập nhật
│   └── popup.js                # Logic tương tác, bộ so sánh semver và kiểm tra cập nhật
├── .github/
│   └── workflows/
│       └── release.yml        # GitHub Actions workflow tự động phát hành release
├── icons/                      # Tệp biểu tượng kích thước 16px, 48px, 128px và SVG
├── package-release.js          # Kịch bản Node.js đóng gói bản phát hành (.zip)
├── generate-icons.js           # Kịch bản Node.js tạo tệp hình ảnh biểu tượng
├── dist/                       # Thư mục chứa gói zip đã đóng gói
└── README.md                   # Tài liệu kỹ thuật
```

---

## 8. Chính sách quyền riêng tư

- Tiện ích chỉ yêu cầu quyền truy cập trên miền youtube.com để phát hiện và định dạng phụ đề.
- Các yêu cầu biên dịch chỉ truyền tải nội dung văn bản phụ đề công khai tới dịch vụ dịch thuật tương ứng.
- Tiện ích không thu thập, ghi lại hoặc truyền tải bất kỳ thông tin nhận dạng cá nhân hay lịch sử duyệt web nào của người dùng.
