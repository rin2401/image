# Xóa nền ảnh — Remove Image Background

🔗 **https://rin2401.github.io/image/**

Công cụ xóa nền ảnh miễn phí, chạy **hoàn toàn trong trình duyệt**. Ảnh không bao giờ được tải lên máy chủ nào.

- ✨ **Chế độ AI** — model IS-Net (ONNX/WASM, chạy bằng `@imgly/background-removal`) tách nền chính xác cho ảnh chụp, người, sản phẩm…
- ⚡ **Chế độ Nhanh** — thuật toán region-growing từ biên ảnh (OkLab color distance), tức thì cho ảnh nền đơn sắc / ảnh studio, có thanh trượt độ nhạy / mềm viền / khử đốm.
- 🖼️ So sánh **trước / sau** bằng thanh kéo, nền caro trong suốt, zoom.
- 💾 Xuất **PNG trong suốt**, **JPG / WebP** với màu nền tuỳ chọn, copy ảnh vào clipboard.
- 📦 **Xử lý hàng loạt**: chọn nhiều ảnh, tải tất cả dưới dạng `.zip`.
- 🔒 Riêng tư: mọi tính toán diễn ra trên máy người dùng (Web Worker + WASM/WebGPU).

## Phát triển

```bash
npm install
npm run assets:models   # tải model AI (~79MB) vào public/imgly/ — chỉ lần đầu
npm run dev             # http://localhost:5173/image/
```

| Lệnh | Mô tả |
| --- | --- |
| `npm run dev` | Dev server (Vite) |
| `npm run build` | Tải asset model (nếu cần), typecheck, build ra `dist/` |
| `npm run preview` | Chạy thử bản build |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test-engine` | Kiểm thử thuật toán xóa nền nhanh (Node) |
| `npm run assets:models -- --force` | Tải lại asset model |

## Kiến trúc

```
index.html            # khung giao diện (semantic, data-* hooks)
src/main.ts           # điều khiển UI
src/style.css         # theme (light/dark), responsive
src/ui/               # thành phần UI nhỏ (compare slider, toast, zip, tiện ích)
src/engine/
  fastCore.ts         # thuật toán xóa nền theo màu nền (thuần, testable)
  fastWorker.ts       # chạy fastCore trong Web Worker
  fast.ts             # wrapper + fallback main-thread
  ai.ts               # nạp lazily @imgly/background-removal, chọn publicPath
scripts/
  fetch-model-assets.mjs  # vendor model ONNX + onnxruntime wasm
  test-engine.mjs         # test thuật toán
.github/workflows/deploy-pages.yml  # CI build + deploy GitHub Pages
```

### Về model AI

Package `@imgly/background-removal` **không** đóng gói sẵn model trong npm (file `dist/resources.json` rỗng).
Khi chạy, nó tải `resources.json` + các chunk ONNX từ `publicPath`. `npm run build` chạy
`scripts/fetch-model-assets.mjs` để tải các asset đó (model `isnet_quint8` ~44MB + onnxruntime wasm ~35MB)
về `public/imgly/`, nhờ vậy GitHub Pages phục vụ chúng cùng origin. Nếu bước này thất bại,
ứng dụng tự động fallback sang CDN của IMG.LY (`staticimgly.com`). Bật thêm model fp16 bằng
`npm run assets:models -- --fp16` (nặng hơn ~88MB).

## Deploy

Push lên `main` → GitHub Actions build và deploy lên GitHub Pages (Settings → Pages → Source: **GitHub Actions**).

Đổi `base` khi cần (ví dụ dùng user site hoặc custom domain):

```bash
GH_PAGES_BASE=/ npm run build
```

## Giấy phép

Mã nguồn của dự án: AGPL-3.0 (do phụ thuộc `@imgly/background-removal` là AGPL-3.0).
Xem [LICENSE](LICENSE).

Made by [rin2401](https://github.com/rin2401) · rin2401@gmail.com
