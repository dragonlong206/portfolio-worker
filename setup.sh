#!/bin/bash
# setup.sh — Script hỗ trợ cài đặt secrets cho Cloudflare Worker
# Chạy: bash setup.sh

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${CYAN}══════════════════════════════════════════${NC}"
echo -e "${CYAN}  Portfolio Manager — Cloudflare Setup    ${NC}"
echo -e "${CYAN}══════════════════════════════════════════${NC}"
echo ""

# Kiểm tra wrangler đã cài chưa
if ! command -v wrangler &> /dev/null; then
  echo -e "${RED}✗ Wrangler chưa được cài.${NC}"
  echo "  Chạy: npm install -g wrangler"
  exit 1
fi

echo -e "${GREEN}✓ Wrangler đã sẵn sàng${NC}"
echo ""

# Kiểm tra đã login chưa
if ! wrangler whoami &> /dev/null 2>&1; then
  echo -e "${YELLOW}→ Đăng nhập Cloudflare...${NC}"
  wrangler login
fi

echo -e "${GREEN}✓ Đã đăng nhập Cloudflare${NC}"
echo ""

echo -e "${CYAN}Điền thông tin bên dưới. Nhấn Enter để bỏ qua (giữ giá trị cũ).${NC}"
echo ""

# ── Spreadsheet ID ───────────────────────────────────────────
echo -e "${YELLOW}[1/5] SPREADSHEET_ID${NC}"
echo "  Lấy từ URL Google Sheets:"
echo "  https://docs.google.com/spreadsheets/d/${RED}SPREADSHEET_ID${NC}/edit"
read -rp "  Nhập Spreadsheet ID: " SHEET_ID
if [[ -n "$SHEET_ID" ]]; then
  echo "$SHEET_ID" | wrangler secret put SPREADSHEET_ID
  echo -e "${GREEN}  ✓ Đã lưu SPREADSHEET_ID${NC}"
fi
echo ""

# ── Google Service Account Key ───────────────────────────────
echo -e "${YELLOW}[2/5] GOOGLE_SERVICE_ACCOUNT_KEY${NC}"
echo "  Nhập path đến file JSON Service Account (đã download từ Google Cloud):"
read -rp "  Path đến file JSON (ví dụ: ~/Downloads/key.json): " SA_PATH
if [[ -n "$SA_PATH" ]]; then
  SA_PATH="${SA_PATH/#\~/$HOME}"
  if [[ -f "$SA_PATH" ]]; then
    SA_B64=$(base64 -i "$SA_PATH" | tr -d '\n')
    echo "$SA_B64" | wrangler secret put GOOGLE_SERVICE_ACCOUNT_KEY
    echo -e "${GREEN}  ✓ Đã mã hóa và lưu Service Account key${NC}"
  else
    echo -e "${RED}  ✗ Không tìm thấy file: $SA_PATH${NC}"
  fi
fi
echo ""

# ── Telegram ─────────────────────────────────────────────────
echo -e "${YELLOW}[3/5] TELEGRAM_BOT_TOKEN${NC}"
echo "  Lấy từ @BotFather trên Telegram"
read -rp "  Nhập Bot Token: " TG_TOKEN
if [[ -n "$TG_TOKEN" ]]; then
  echo "$TG_TOKEN" | wrangler secret put TELEGRAM_BOT_TOKEN
  echo -e "${GREEN}  ✓ Đã lưu TELEGRAM_BOT_TOKEN${NC}"
fi
echo ""

echo -e "${YELLOW}[4/5] TELEGRAM_CHAT_ID${NC}"
echo "  Lấy bằng cách nhắn cho bot rồi vào:"
echo "  https://api.telegram.org/bot{TOKEN}/getUpdates"
read -rp "  Nhập Chat ID: " TG_CHAT_ID
if [[ -n "$TG_CHAT_ID" ]]; then
  echo "$TG_CHAT_ID" | wrangler secret put TELEGRAM_CHAT_ID
  echo -e "${GREEN}  ✓ Đã lưu TELEGRAM_CHAT_ID${NC}"
fi
echo ""

# ── CoinGecko ────────────────────────────────────────────────
echo -e "${YELLOW}[5/5] COINGECKO_API_KEY (không bắt buộc)${NC}"
echo "  Đăng ký miễn phí tại coingecko.com/api để có rate limit ổn định hơn"
echo "  Để trống nếu chưa có (vẫn hoạt động, chỉ chậm hơn một chút)"
read -rp "  Nhập CoinGecko API Key (Enter để bỏ qua): " CG_KEY
if [[ -n "$CG_KEY" ]]; then
  echo "$CG_KEY" | wrangler secret put COINGECKO_API_KEY
  echo -e "${GREEN}  ✓ Đã lưu COINGECKO_API_KEY${NC}"
fi
echo ""

# ── Sync Secret ──────────────────────────────────────────────
SYNC_SECRET=$(openssl rand -hex 16 2>/dev/null || cat /dev/urandom | head -c 16 | base64)
echo "$SYNC_SECRET" | wrangler secret put SYNC_SECRET
echo -e "${GREEN}✓ SYNC_SECRET tự động tạo: ${SYNC_SECRET}${NC}"
echo ""

# ── Deploy ───────────────────────────────────────────────────
echo -e "${CYAN}Sẵn sàng deploy!${NC}"
read -rp "Deploy Worker ngay bây giờ? (y/n): " DO_DEPLOY
if [[ "$DO_DEPLOY" == "y" || "$DO_DEPLOY" == "Y" ]]; then
  wrangler deploy
  echo ""
  echo -e "${GREEN}══════════════════════════════════════════${NC}"
  echo -e "${GREEN}  ✓ Deploy thành công!                   ${NC}"
  echo -e "${GREEN}══════════════════════════════════════════${NC}"
  echo ""
  echo "Bước cuối: kích hoạt Telegram webhook"
  echo "Chạy lệnh sau (thay YOUR_SUBDOMAIN bằng subdomain Cloudflare của bạn):"
  echo ""
  echo -e "  ${CYAN}curl -X POST https://portfolio-manager.YOUR_SUBDOMAIN.workers.dev/setup-webhook${NC}"
  echo ""
  echo "Sau đó gửi /help cho bot Telegram để kiểm tra!"
fi

echo ""
echo -e "${GREEN}Hoàn tất setup!${NC}"
