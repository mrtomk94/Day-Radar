# Day Radar

Bản cổ phiếu Mỹ của Pullback Radar, chuyên day trade (app dài hạn và LEAP là repo Stock Radar riêng): quét các mã đang có **sóng đẩy trong ngày** và báo kế hoạch vào lệnh hồi. **Chỉ quét và báo, không đặt lệnh.**

- **Fibo**: E1/E2/E3 ở 0.236 / 0.382 / 0.5 của sóng, SL ở 0.618, TP ở đỉnh sóng.
- **EMA**: vào ở EMA 9 và EMA 20, SL 1.5% dưới mức thấp nhất, TP ở đỉnh sóng.
- Khung mặc định **15m và 1h** (có thêm 5m, 30m). Sóng tối thiểu 4%, chân sóng trong 40 nến.
- **Day trade**: setup chưa khớp sẽ huỷ khi hết phiên, lệnh đang giữ được tính đóng ở giá cuối phiên (tắt được trong Cài đặt).

## Nguồn mã quét (bật/tắt trong Cài đặt)
| Nguồn | Lấy gì |
|---|---|
| Top tăng | Danh sách "Day Gainers" của Yahoo |
| Sôi động | "Most Active" của Yahoo |
| S&P 500 + Nasdaq 100 | Mỗi 30 phút lấy % tăng và khối lượng hôm nay của ~520 mã, chọn 25 mã mạnh nhất (điểm = % tăng × khối lượng tương đối) |
| Watchlist | Danh sách mã của bạn, luôn quét |

Bộ lọc: giá ≥ 2$, giá trị giao dịch hôm nay ≥ 5 triệu $ (không áp cho watchlist).

## Dữ liệu lấy từ đâu
Yahoo Finance, miễn phí, không cần tài khoản:
- Nến: `https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=15m&range=5d`
- Top tăng: `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=day_gainers`

Đây là API **không chính thức**: Yahoo có thể giới hạn tần suất (lỗi 429) hoặc đổi định dạng. Code tự thử lại và bỏ qua mã lỗi. Dữ liệu miễn phí có thể trễ vài phút so với thời gian thực. Yahoo chỉ cho khoảng 60 ngày nến 5m/15m/30m và khoảng 2 năm nến 1h, nên backtest bị giới hạn theo đó.

## Lịch quét
Mỗi 15 phút **trong giờ giao dịch** (6:30 sáng đến 1:00 chiều giờ PT, thứ Hai đến thứ Sáu), cộng thêm một lần ngay sau khi đóng cửa để chốt các lệnh cuối phiên. Ngoài giờ, bấm ↻ để quét dữ liệu phiên gần nhất. App chưa có lịch ngày lễ: hôm lễ nó vẫn quét nhưng không có nến mới.

## Chạy
```bash
cd day-radar
DEMO=1 node server.js     # dữ liệu mẫu để xem giao diện
node server.js            # dữ liệu Yahoo thật
```
Mở http://localhost:8081. Chỉ cần Node.js 18 trở lên, không cần cài thư viện. Chạy được ngay trên máy ở Mỹ (khác Binance, Yahoo không chặn).

## Tab Báo cáo (watchlist)
Mỗi 6 giờ (và ngay sau ngày báo cáo của từng mã) app lấy từ Yahoo Finance:
- Doanh thu quý gần nhất và tăng trưởng so với cùng kỳ, EPS so với dự báo, lịch sử 4 quý.
- Biên gộp, biên hoạt động, dòng tiền tự do 12 tháng, nợ và tiền mặt.
- Dự báo của giới phân tích cho quý này, quý tới, năm nay, năm sau; giá mục tiêu; ngày báo cáo tới.
- Đánh giá TÍCH CỰC / LẪN LỘN / THẬN TRỌNG / TIÊU CỰC theo luật cố định trong `lib/fundamentals.js` (vượt/hụt dự báo, tăng trưởng, biên, dòng tiền, xu hướng nâng/hạ dự báo).

Yahoo **không có** doanh thu theo phân khúc và hướng dẫn của công ty, nên phần đó chỉ có trong bản báo cáo chi tiết do Claude soạn (link trong app). Watchlist mặc định gồm 14 mã: AAPL NVDA TSLA AMD META PLTR SOFI MARA MU SPCX GOOGL NFLX MSFT AMZN.

## Quyền chọn bất thường (giống Ripple)
Cùng nguồn và luật với Ripple: chuỗi quyền chọn trễ ~15 phút của Cboe (`cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json`), không cần tài khoản. Một giao dịch được đánh dấu khi:
- khối lượng ≥ 1.000 hợp đồng, **và** lớn hơn 2 lần open interest,
- tổng phí ≥ 1 triệu $,
- đáo hạn trong 60 ngày (tăng lên ~800 trong Cài đặt nếu muốn thấy cả LEAPS).

Quét mỗi giờ trong phiên và một lần sau khi đóng cửa. Mỗi mã còn có tổng phí CALL/PUT và tỉ lệ Put/Call trong ngày. Telegram báo tối đa 5 giao dịch mới mỗi lần quét. Dữ liệu chỉ cho biết có giao dịch, không cho biết bên mua hay bán.

## Telegram
Điền `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID` trong `.env`. Bot báo setup mới, chốt TP, dính SL, đóng cuối phiên. Chọn khung nào được báo trong Cài đặt.

## Chạy miễn phí trên GitHub (giống keno-auto và Ripple)
GitHub Actions tự chạy quét **mỗi 15 phút trong giờ giao dịch** (thứ Hai–thứ Sáu), làm mới báo cáo, quét quyền chọn, gửi Telegram, rồi đăng giao diện lên **GitHub Pages**. Không cần server, không cần bật máy.

1. Tạo repo mới trên GitHub, đặt **Public** (GitHub Pages miễn phí cần Public; repo không chứa gì bí mật).
2. Tải toàn bộ file trong thư mục `day-radar` lên (kéo thả, gồm cả thư mục `.github`). Không tải `.env`.
   - Nếu kéo thả không nhận thư mục `.github` (thư mục ẩn), tạo file bằng nút **Add file → Create new file**, gõ tên `.github/workflows/scan.yml` rồi dán nội dung; làm tương tự với `backtest.yml`.
3. **Settings → Pages → Source: GitHub Actions**.
4. **Settings → Secrets and variables → Actions → New repository secret**: thêm `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID` (nếu muốn báo Telegram).
5. Tab **Actions** → chọn **Day Radar scan** → **Run workflow** để chạy lần đầu. Vài phút sau trang có ở `https://<tên-github>.github.io/<tên-repo>/`.
6. Đổi watchlist, ngưỡng sóng, luật quyền chọn: sửa file **settings.json** trên GitHub rồi Commit.
7. Backtest: Actions → **Day Radar backtest** → Run workflow, điền phạm vi mã, khung, số ngày.

Lưu ý: lịch của GitHub hay chạy trễ vài phút; Yahoo đôi khi chặn tạm máy của GitHub (lỗi 429), khi đó lượt sau sẽ thử lại. Chạy trên máy (`node server.js`) vẫn dùng được như cũ.

## Đưa lên Render
Đẩy lên GitHub → Render → New → Blueprint. Dùng gói Starter để server không ngủ.

## Quy ước backtest
Không nhìn trước tương lai; nến vừa chạm SL vừa chạm TP tính SL; nến vừa khớp không tính TP; không tính trượt giá; danh sách chỉ số là thành phần hiện tại nên có thiên lệch "mã còn sống". "Tổng lãi cộng dồn" là cộng % từng lệnh, không phải lãi kép.

Đây là công cụ nghiên cứu, không phải lời khuyên đầu tư.
