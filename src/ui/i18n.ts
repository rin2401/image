/**
 * Lightweight i18n for the app chrome (ru + vi).
 *
 * Language is chosen by: `?lang=` URL param → <html lang> → browser language
 * → default. Markup authored in index.html declares which language it was
 * written in; if that differs from the chosen one we overwrite the documented
 * `data-i18n` slots (and keep the text otherwise untouched).
 */

export type Lang = 'vi' | 'ru';

type Dict = Record<string, string>;

const vi: Dict = {
  'app.tagline': 'Bỏ phông nền trực tiếp trên thiết bị — ảnh không rời khỏi máy của bạn',
  'app.title': 'Bỏ phông nền',
  'app.skip': 'Chuyển tới nội dung chính',

  'privacy.badge': 'Ảnh được xử lý ngay trên thiết bị của bạn — không tải lên máy chủ',

  'dropzone.title': 'Kéo thả ảnh vào đây',
  'dropzone.or': 'hoặc',
  'dropzone.browse': 'Chọn ảnh từ máy',
  'dropzone.hint': 'PNG, JPG, WEBP, GIF · tối đa {max} MB · dán bằng Ctrl/⌘ + V',
  'dropzone.demo': 'Dùng ảnh mẫu',
  'dropzone.dropover': 'Thả ảnh để bắt đầu',
  'dropzone.demoHint': 'Đây là ảnh mẫu — hãy thử kéo thanh so sánh!',

  'engine.title': 'Chế độ xử lý',
  'engine.ai': 'AI (chất lượng cao)',
  'engine.ai.desc': 'Tải mô hình lần đầu (~{mb} MB), sau đó chạy ngay trên máy. Tốt nhất cho ảnh chân dung, sản phẩm, lông tóc.',
  'engine.fast': 'Nhanh (nền đơn sắc)',
  'engine.fast.desc': 'Áp dụng ngay lập tức. Hợp với ảnh có phông nền trơn, ít chi tiết.',
  'engine.badge.recommended': 'Đề xuất',

  'slider.tolerance': 'Độ nhạy',
  'slider.feather': 'Làm mượt viền',
  'slider.despeckle': 'Khử đốm',
  'slider.reset': 'Đặt lại',

  'viewer.compare': 'So sánh trước / sau',
  'viewer.fit': 'Vừa khung',
  'viewer.actual': 'Kích thước thật',
  'viewer.zoomIn': 'Phóng to',
  'viewer.zoomOut': 'Thu nhỏ',
  'viewer.reset': 'Đặt lại',
  'viewer.original': 'Ảnh gốc',
  'viewer.result': 'Đã xóa nền',
  'viewer.checker': 'Nền trong suốt (ô caro)',
  'viewer.prev': 'Ảnh trước',
  'viewer.next': 'Ảnh tiếp',

  'export.title': 'Xuất ảnh',
  'export.bg': 'Màu nền',
  'export.transparent': 'Trong suốt',
  'export.white': 'Trắng',
  'export.black': 'Đen',
  'export.png': 'Tải PNG',
  'export.jpg': 'Tải JPG',
  'export.webp': 'Tải WebP',
  'export.copy': 'Sao chép ảnh',
  'export.reset': 'Làm lại',

  'batch.title': 'Hàng đợi',
  'batch.zip': 'Tải tất cả (.zip)',
  'batch.clear': 'Xóa danh sách',
  'batch.empty': 'Chưa có ảnh nào trong hàng đợi.',
  'batch.processing': 'Đang xử lý…',
  'batch.remaining': 'Còn {n} ảnh',

  'status.idle': 'Sẵn sàng',
  'status.reading': 'Đang đọc ảnh…',
  'status.fast': 'Đang tách nền…',
  'status.ai': 'Đang tải mô hình AI…',
  'status.aiRun': 'AI đang tách nền…',
  'status.done': 'Hoàn tất',
  'status.error': 'Lỗi',

  'toast.unsupported': 'Định dạng không hỗ trợ: {name}. Hãy dùng PNG, JPG, WEBP hoặc GIF.',
  'toast.tooBig': '{name} quá lớn ({size}). Giới hạn là {max} MB.',
  'toast.tooManyPixels': '{name} có độ phân giải quá cao ({mp}). Giới hạn là {max_mp} MP.',
  'toast.noFiles': 'Không tìm thấy ảnh hợp lệ trong dữ liệu dán.',
  'toast.copied': 'Đã sao chép ảnh vào bộ nhớ tạm.',
  'toast.copiedHtml': 'Trình duyệt chỉ cho phép sao chép dạng HTML — hãy dán vào trình soạn thảo hỗ trợ ảnh.',
  'toast.copyFailed': 'Không thể sao chép: {msg}',
  'toast.downloaded': 'Đã tải xuống {name}',
  'toast.engineUnavailable': 'Không tải được bộ xử lý ảnh. Vui lòng tải lại trang.',
  'toast.zipEmpty': 'Chưa có ảnh nào đã xử lý để đóng gói.',
  'toast.processing': 'Đang xử lý {n} ảnh…',
  'toast.batchDone': 'Đã xử lý xong {n} ảnh.',
  'toast.errorGeneric': 'Đã xảy ra lỗi khi xử lý ảnh.',
  'toast.passedMax': 'Chỉ xử lý được {n} ảnh mỗi lần.',

  'error.tooLarge': 'Ảnh quá lớn để xử lý trên thiết bị này. Hãy thử ảnh nhỏ hơn hoặc chế độ Nhanh.',
  'error.model': 'Không tải được mô hình AI. Kiểm tra kết nối mạng rồi thử lại, hoặc dùng chế độ Nhanh.',
  'error.noExport': 'Chưa có ảnh đã xử lý để xuất.',
  'error.canvas': 'Trình duyệt không hỗ trợ canvas.',
  'error.encoding': 'Không tạo được tệp ảnh.',
  'export.webpFallback': 'Trình duyệt không hỗ trợ WebP — đã xuất PNG thay thế.',
  'zip.busy': 'Đang đóng gói…',
  'zip.done': 'Đã đóng gói {n} ảnh vào tệp ZIP.',
  'zip.fail': 'Không tạo được tệp ZIP.',
  'zip.buttonTitle': 'Đóng gói {n} ảnh thành ZIP',
  'batch.view': 'Xem',
  'batch.download': 'Tải',
  'batch.remove': 'Xóa khỏi danh sách',
  'batch.queued': 'Chờ xử lý',
  'batch.retry': 'Thử lại',
  'model.label': 'Mô hình AI',
  'model.fast': 'Nhanh gọn',
  'model.fast.desc': '~44 MB · phù hợp đa số ảnh',
  'model.hq': 'Chất lượng cao',
  'model.hq.desc': '~88 MB · chi tiết tóc/vật thể tốt hơn',
  'footer.madeBy': 'Made by rin2401',
  'footer.privacy': 'Ảnh được xử lý ngay trên thiết bị của bạn — không tải lên máy chủ',
};

const ru: Dict = {
  'app.tagline': 'Удаление фона прямо на устройстве — фото не покидают ваш компьютер',
  'app.title': 'Удаление фона',
  'app.skip': 'Перейти к содержимому',

  'privacy.badge': 'Фото обрабатываются прямо на устройстве — ничего не загружается на сервер',

  'dropzone.title': 'Перетащите изображение сюда',
  'dropzone.or': 'или',
  'dropzone.browse': 'Выбрать файл',
  'dropzone.hint': 'PNG, JPG, WEBP, GIF · до {max} МБ · вставка по Ctrl/⌘ + V',
  'dropzone.demo': 'Попробовать на примере',
  'dropzone.dropover': 'Отпустите, чтобы начать',
  'dropzone.demoHint': 'Это демо-изображение — попробуйте потянуть ползунок сравнения!',

  'engine.title': 'Режим обработки',
  'engine.ai': 'Нейросеть (высшее качество)',
  'engine.ai.desc': 'При первом запуске скачивается модель (~{mb} МБ), затем всё работает офлайн. Лучший выбор для людей, товаров и волос.',
  'engine.fast': 'Быстро (однотонный фон)',
  'engine.fast.desc': 'Мгновенный результат. Подходит для изображений с ровным фоном.',
  'engine.badge.recommended': 'Рекомендуется',

  'slider.tolerance': 'Чувствительность',
  'slider.feather': 'Сглаживание краёв',
  'slider.despeckle': 'Удаление точек',
  'slider.reset': 'Сбросить',

  'viewer.compare': 'Сравнение до / после',
  'viewer.fit': 'По размеру',
  'viewer.actual': '100%',
  'viewer.zoomIn': 'Увеличить',
  'viewer.zoomOut': 'Уменьшить',
  'viewer.reset': 'Сбросить',
  'viewer.original': 'Оригинал',
  'viewer.result': 'Без фона',
  'viewer.checker': 'Прозрачный фон (шахматка)',
  'viewer.prev': 'Предыдущее',
  'viewer.next': 'Следующее',

  'export.title': 'Экспорт',
  'export.bg': 'Цвет фона',
  'export.transparent': 'Прозрачный',
  'export.white': 'Белый',
  'export.black': 'Чёрный',
  'export.png': 'Скачать PNG',
  'export.jpg': 'Скачать JPG',
  'export.webp': 'Скачать WebP',
  'export.copy': 'Копировать',
  'export.reset': 'Ещё раз',

  'batch.title': 'Очередь',
  'batch.zip': 'Скачать всё (.zip)',
  'batch.clear': 'Очистить',
  'batch.empty': 'В очереди пока нет изображений.',
  'batch.processing': 'Обработка…',
  'batch.remaining': 'Осталось: {n}',

  'status.idle': 'Готово к работе',
  'status.reading': 'Чтение файла…',
  'status.fast': 'Удаляем фон…',
  'status.ai': 'Загружаем модель…',
  'status.aiRun': 'Нейросеть обрабатывает…',
  'status.done': 'Готово',
  'status.error': 'Ошибка',

  'toast.unsupported': 'Формат не поддерживается: {name}. Используйте PNG, JPG, WEBP или GIF.',
  'toast.tooBig': '{name} слишком большой ({size}). Максимум — {max} МБ.',
  'toast.tooManyPixels': 'Слишком высокое разрешение: {name} ({mp}). Максимум — {max_mp} МПа.',
  'toast.noFiles': 'В буфере обмена не найдено изображений.',
  'toast.copied': 'Изображение скопировано в буфер обмена.',
  'toast.copiedHtml': 'Браузер разрешил только HTML-копирование — вставьте в редактор с поддержкой картинок.',
  'toast.copyFailed': 'Не удалось скопировать: {msg}',
  'toast.downloaded': 'Файл {name} скачан',
  'toast.engineUnavailable': 'Не удалось загрузить движок обработки. Обновите страницу.',
  'toast.zipEmpty': 'Пока нет обработанных изображений для архива.',
  'toast.processing': 'Обрабатываем изображений: {n}…',
  'toast.batchDone': 'Обработано изображений: {n}.',
  'toast.errorGeneric': 'При обработке произошла ошибка.',
  'toast.passedMax': 'За раз можно обработать не больше {n} файлов.',

  'error.tooLarge': 'Изображение слишком велико для обработки на этом устройстве. Попробуйте файл меньше или режим «Быстро».',
  'error.model': 'Не удалось загрузить модель ИИ. Проверьте соединение и повторите, либо выберите режим «Быстро».',
  'error.noExport': 'Пока нет обработанного изображения для экспорта.',
  'error.canvas': 'Браузер не поддерживает canvas.',
  'error.encoding': 'Не удалось создать файл изображения.',
  'export.webpFallback': 'Браузер не поддерживает WebP — сохранён PNG.',
  'zip.busy': 'Упаковываем…',
  'zip.done': 'Изображений в архиве: {n}.',
  'zip.fail': 'Не удалось создать ZIP-архив.',
  'zip.buttonTitle': 'Собрать {n} изображений в ZIP',
  'batch.view': 'Открыть',
  'batch.download': 'Скачать',
  'batch.remove': 'Убрать из списка',
  'batch.queued': 'В очереди',
  'batch.retry': 'Повторить',
  'model.label': 'Модель ИИ',
  'model.fast': 'Компактная',
  'model.fast.desc': '~44 МБ · подходит для большинства фото',
  'model.hq': 'Максимальное качество',
  'model.hq.desc': '~88 МБ · лучше прорабатывает волосы и мелкие детали',
  'footer.madeBy': 'Made by rin2401',
  'footer.privacy': 'Фото обрабатываются прямо на устройстве — ничего не загружается на сервер',
};

const DICTS: Record<Lang, Dict> = { vi, ru };
const DEFAULT_LANG: Lang = 'vi';

let current: Lang = DEFAULT_LANG;

function normalize(raw: string | null | undefined): Lang | null {
  if (!raw) return null;
  const short = raw.toLowerCase().slice(0, 2);
  return short in DICTS ? (short as Lang) : null;
}

export function detectLang(): Lang {
  try {
    const url = new URL(window.location.href);
    const fromQuery = normalize(url.searchParams.get('lang'));
    if (fromQuery) return fromQuery;
  } catch {
    /* ignore malformed URL */
  }
  // index.html is authored in Vietnamese; only switch away from it when the
  // visitor explicitly asked for another language (via ?lang= or the browser
  // language being a supported one that differs from the page language).
  const pageLang = normalize(document.documentElement.lang) ?? DEFAULT_LANG;
  const nav =
    typeof navigator !== 'undefined' ? normalize(navigator.languages?.[0] ?? navigator.language) : null;
  return nav ?? pageLang;
}

export function initI18n(): Lang {
  current = detectLang();
  document.documentElement.lang = current;
  return current;
}

export function getLang(): Lang {
  return current;
}

export type TParams = Record<string, string | number>;

export function t(key: string, params?: TParams): string {
  const template = DICTS[current][key] ?? DICTS[DEFAULT_LANG][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Localised engine label (same wording as the radio cards). */
export function engineLabel(mode: 'ai' | 'fast'): string {
  return t(mode === 'ai' ? 'engine.ai' : 'engine.fast');
}
