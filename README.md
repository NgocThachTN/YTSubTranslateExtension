# YouTube Subtitle Translator (YT ViSub)
<img width="500" height="492" alt="image" src="https://github.com/user-attachments/assets/d8015730-34a7-4ba4-9d67-5da51a39e49f" />


## Project Structure 

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
