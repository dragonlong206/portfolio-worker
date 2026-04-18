# 📊 Portfolio Manager — Cloudflare Worker

Ứng dụng quản lý danh mục đầu tư cá nhân chạy hoàn toàn serverless trên Cloudflare Workers.  
Dữ liệu lưu trên Google Sheets của **bạn** — không ai khác (kể cả tác giả) có thể truy cập.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USERNAME/portfolio-manager-worker)

---

## Tính năng

- **Sync giá tự động** mỗi giờ: crypto từ CoinGecko, tỷ giá USD/VND từ open.er-api.com
- **Cảnh báo Telegram** khi danh mục vượt ngưỡng phân bổ đã cài đặt
- **Telegram Bot** hỗ trợ lệnh: `/portfolio` `/alerts` `/sync` `/top`
- **Hoàn toàn miễn phí**: Cloudflare Workers free tier (100,000 req/ngày), Google Sheets, CoinGecko
- **Bảo mật cao**: mỗi người chạy Worker riêng trên account Cloudflare của họ, API keys mã hóa

---

## Yêu cầu

- Tài khoản [Cloudflare](https://cloudflare.com) (miễn phí)
- Tài khoản [Google](https://google.com) (đã có Gmail)
- File Google Sheets đã cài đặt từ template (xem bên dưới)

---

## Cài đặt (3 bước chính)

### Bước 1 — Chuẩn bị Google Sheets

**1a. Copy Google Sheets template về Drive của bạn:**

👉 [Click vào đây để copy template](https://docs.google.com/spreadsheets/d/YOUR_TEMPLATE_ID/copy)

**1b. Lấy Spreadsheet ID:**

URL của Sheets trông như thế này:
```
https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit
                                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                        Đây là Spreadsheet ID — copy lại
```

**1c. Tạo Google Service Account (để Worker đọc/ghi Sheets):**

> Nghe phức tạp nhưng thực ra chỉ cần làm một lần, khoảng 5 phút.

1. Vào [Google Cloud Console](https://console.cloud.google.com)
2. Tạo project mới (hoặc dùng project có sẵn) → đặt tên tùy ý
3. Menu trái → **APIs & Services** → **Library** → tìm **Google Sheets API** → Enable
4. Menu trái → **IAM & Admin** → **Service Accounts** → **Create Service Account**
   - Name: `portfolio-worker` → Create
5. Click vào service account vừa tạo → tab **Keys** → **Add Key** → **Create new key** → JSON → Download
6. Mở file JSON vừa tải, convert sang base64:
   ```bash
   # Trên Mac/Linux:
   base64 -i downloaded-key.json | tr -d '\n'
   
   # Trên Windows (PowerShell):
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("downloaded-key.json"))
   ```
   Lưu chuỗi base64 này lại — đây là `GOOGLE_SERVICE_ACCOUNT_KEY`

7. Mở file JSON, copy giá trị `client_email` (dạng `xxx@yyy.iam.gserviceaccount.com`)
8. Mở Google Sheets → nút **Share** → paste email service account → quyền **Editor** → Share

---

### Bước 2 — Deploy Worker

**Cách A: Dùng nút Deploy (đơn giản nhất)**

Click nút **Deploy to Cloudflare Workers** ở đầu trang này.  
Cloudflare sẽ tự fork repo và deploy cho bạn.

**Cách B: Deploy thủ công (nếu muốn tùy chỉnh code)**

```bash
# Cài wrangler CLI
npm install -g wrangler

# Clone repo
git clone https://github.com/YOUR_USERNAME/portfolio-manager-worker
cd portfolio-manager-worker

# Đăng nhập Cloudflare
wrangler login

# Deploy
wrangler deploy
```

---

### Bước 3 — Cài đặt Secret Variables

Vào [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → chọn worker `portfolio-manager` → **Settings** → **Variables** → **Add variable**

Thêm lần lượt các biến sau (chọn **Encrypt** cho tất cả):

| Tên biến | Giá trị | Cách lấy |
|---|---|---|
| `SPREADSHEET_ID` | ID của Google Sheet | Xem Bước 1b |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Chuỗi base64 của file JSON | Xem Bước 1c |
| `COINGECKO_API_KEY` | Demo API key | [coingecko.com/api](https://coingecko.com/api) → đăng ký miễn phí (không bắt buộc) |
| `TELEGRAM_BOT_TOKEN` | Token từ @BotFather | Xem hướng dẫn Telegram bên dưới |
| `TELEGRAM_CHAT_ID` | Chat ID của bạn | Xem hướng dẫn Telegram bên dưới |
| `SYNC_SECRET` | Chuỗi bất kỳ (ví dụ `abc123xyz`) | Tự đặt — dùng để trigger sync thủ công |

---

### Bước 4 — Cài đặt Telegram Bot

1. Mở Telegram, tìm **@BotFather**
2. Gõ `/newbot` → đặt tên bot → nhận **Token** (dạng `123456:ABC-DEF...`)
3. Lấy Chat ID: nhắn bất kỳ gì cho bot vừa tạo, sau đó truy cập:
   ```
   https://api.telegram.org/bot{TOKEN}/getUpdates
   ```
   Tìm `"chat": {"id": 123456789}` — đây là **Chat ID**

4. Sau khi điền đủ secrets, gọi endpoint này để kích hoạt webhook:
   ```bash
   curl -X POST https://portfolio-manager.YOUR_SUBDOMAIN.workers.dev/setup-webhook
   ```

---

### Bước 5 — Kiểm tra

Gửi `/help` cho bot Telegram → nếu bot trả lời là thành công!

Xem logs thực thi trong Cloudflare Dashboard → Workers → **Logs**.

---

## Lệnh Telegram Bot

| Lệnh | Mô tả |
|---|---|
| `/portfolio` | Xem tổng quan danh mục và tỉ trọng |
| `/alerts` | Kiểm tra ngưỡng phân bổ ngay |
| `/sync` | Đồng bộ giá từ CoinGecko ngay |
| `/top` | Top 5 tài sản lớn nhất |
| `/help` | Xem danh sách lệnh |

---

## Cấu trúc dữ liệu Google Sheets

| Sheet | Mô tả |
|---|---|
| `ASSETS` | Danh sách tài sản — nhập tay hoặc sync |
| `ALLOCATION` | Phân bổ và ngưỡng cảnh báo — công thức tự tính |
| `CONFIG` | Cấu hình ngưỡng, tỷ giá, Telegram |
| `PRICE_HISTORY` | Lịch sử giá — Worker ghi tự động |
| `ALERT_LOG` | Nhật ký cảnh báo |

**Nguồn dữ liệu giá (`Loại nguồn` trong ASSETS):**

| Giá trị | Ý nghĩa |
|---|---|
| `COINGECKO` | Giá crypto lấy từ CoinGecko API tự động |
| `BINANCE` | Số dư trên Binance — giá lấy từ CoinGecko (Binance API bị block IP Mỹ) |
| `GOOGLEFINANCE` | Cổ phiếu — dùng hàm `=GOOGLEFINANCE()` trong Sheets |
| `MANUAL` | Nhập tay, không tự động cập nhật giá |

---

## Bảo mật

- **API keys** lưu dưới dạng encrypted secrets trong Cloudflare — không ai đọc được, kể cả qua dashboard
- **Google Service Account** chỉ có quyền `spreadsheets` — không truy cập được Drive, Gmail, hay bất cứ thứ gì khác
- **Telegram webhook** chỉ phản hồi đúng `TELEGRAM_CHAT_ID` đã cấu hình — người khác nhắn vào bot sẽ bị từ chối
- **Mỗi người chạy Worker riêng** — không có server trung gian, không có database chung

---

## Cập nhật khi có phiên bản mới

```bash
# Pull changes từ upstream
git remote add upstream https://github.com/YOUR_USERNAME/portfolio-manager-worker
git fetch upstream
git merge upstream/main

# Deploy lại
wrangler deploy
```

---

## Câu hỏi thường gặp

**Q: Worker có đọc được password hay tài sản của tôi không?**  
A: Không. Worker chỉ đọc/ghi vào đúng Google Sheet của bạn, dùng Service Account mà bạn tạo. Tác giả không có quyền truy cập.

**Q: Binance API có hoạt động không?**  
A: Binance API bị block IP từ Mỹ (nơi nhiều server đặt). Cloudflare Workers chạy trên edge toàn cầu nên IP khác nhau, nhưng để đảm bảo, app dùng CoinGecko cho giá crypto (tương đương, không bị block). Số dư Binance vẫn nhập tay.

**Q: Free tier Cloudflare đủ dùng không?**  
A: Rất dư — 100,000 requests/ngày. App chỉ dùng ~24 requests/ngày (mỗi giờ 1 lần).

**Q: Cron trigger chạy vào lúc nào?**  
A: Phút 0 của mỗi giờ UTC. Ví dụ 1:00 UTC = 8:00 sáng giờ Việt Nam.

---

## License

MIT — tự do sử dụng, chỉnh sửa, và phân phối.
