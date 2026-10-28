// Tài liệu đồng bộ giữa các thiết bị (mã hóa bằng khóa riêng trước khi gửi lên máy chủ).
// Mỗi mục mang dấu thời gian t; gộp hai bản = lấy mục có t lớn hơn (ai sửa sau thì thắng), theo TỪNG mục
// -> sửa hội thoại A ở máy 1 và hội thoại B ở máy 2 cùng lúc thì giữ được cả hai.
// {
//   v: 1,
//   convPrefs: { [convId]: { pinned, muted, unread, archived, labels, clearedAt, accepted, t } },
//   labels:    { list: [{id,name,color}], t },
//   drafts:    { [convId]: { text, t } },          // text '' = đã xóa nháp (giữ dấu để không bị máy khác "hồi sinh")
//   hidden:    { [messageId]: t },                 // tin "xóa phía tôi"
//   starred:   { [messageId]: { on, t, convId, preview, at } },
// }
export const emptyDoc = () => ({ v: 1, convPrefs: {}, labels: { list: [], t: 0 }, drafts: {}, hidden: {}, starred: {} });

const newer = (a, b) => ((b?.t || 0) > (a?.t || 0) ? b : a);
const mergeMap = (a = {}, b = {}) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? newer(out[k], v) : v;
  return out;
};

export function mergeDocs(a, b) {
  a = { ...emptyDoc(), ...(a || {}) }; b = { ...emptyDoc(), ...(b || {}) };
  const hidden = { ...a.hidden };
  for (const [k, t] of Object.entries(b.hidden || {})) hidden[k] = Math.max(hidden[k] || 0, t || 0);
  return {
    v: 1,
    convPrefs: mergeMap(a.convPrefs, b.convPrefs),
    labels: newer(a.labels, b.labels) || { list: [], t: 0 },
    drafts: mergeMap(a.drafts, b.drafts),
    hidden,
    starred: mergeMap(a.starred, b.starred),
  };
}

// So sánh nội dung (bỏ qua thứ tự khóa) để biết có cần gửi lên không.
export const docHash = (d) => JSON.stringify(d, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1))) : v));
