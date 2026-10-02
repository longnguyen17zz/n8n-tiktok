import { GoogleGenAI } from '@google/genai';
import { CONFIG } from './config.js';

const ai = new GoogleGenAI({ apiKey: CONFIG.GEMINI_API_KEY });
const CANDIDATE_MODELS = ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'];

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} quá ${ms}ms, có thể model đang quá tải`)), ms))
]);

export async function generateContentWithFallback(contents, options = {}) {
  let lastErr = null;
  for (const m of CANDIDATE_MODELS) {
    try {
      const res = await withTimeout(
        ai.models.generateContent({ model: m, contents, ...options }),
        45000,
        `Gọi Gemini model "${m}"`
      );
      if (res && res.text) return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Không thể kết nối tới các model Gemini.');
}

export async function analyzeProduct(imageBuffer, productName) {
  const prompt = `Bạn là chuyên gia phân tích sản phẩm quảng cáo video. Tên sản phẩm: ${productName}. Hãy mô tả chi tiết bằng TIẾNG VIỆT trong 1 đoạn văn liên tục về kiểu dáng, màu sắc, chất liệu và điểm nhấn đặc trưng của sản phẩm. Chỉ trả về văn bản tiếng Việt thuần túy, không định dạng markdown hay gạch đầu dòng.`;
  const contents = [
    { text: prompt },
    { inlineData: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } }
  ];
  const res = await generateContentWithFallback(contents);
  return res.text.trim();
}

export async function analyzeModel(imageBuffer) {
  const prompt = `Phân tích chi tiết người mẫu trong bức ảnh này để làm prompt tạo video. Trả về đúng 1 đoạn văn bằng TIẾNG VIỆT mô tả sắc thái khuôn mặt, làn da, đôi mắt, sống mũi, khóe môi, kiểu tóc và trang phục. Chỉ trả về văn bản thuần túy bằng tiếng Việt.`;
  const contents = [
    { text: prompt },
    { inlineData: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } }
  ];
  const res = await generateContentWithFallback(contents);
  return res.text.trim();
}

export async function analyzeBackground(imageBuffer) {
  const prompt = `Phân tích không gian bối cảnh, phòng ốc, ánh sáng, tường và đồ nội thất trong bức ảnh này. Hoàn toàn bỏ qua con người. Trả về đúng 1 đoạn văn bằng TIẾNG VIỆT tự nhiên mô tả không gian sang trọng, ánh sáng ấm áp.`;
  const contents = [
    { text: prompt },
    { inlineData: { mimeType: 'image/jpeg', data: imageBuffer.toString('base64') } }
  ];
  const res = await generateContentWithFallback(contents);
  return res.text.trim();
}

export async function generateImagePrompts(numPrompts, productAnalysis, modelAnalysis, bgAnalysis, contentVideo) {
  const prompt = `Return ONLY a valid JSON array of ${numPrompts} strings. Each string is a safe 9:16 vertical product advertising keyframe prompt combining:
Product: ${productAnalysis}
Model: ${modelAnalysis}
Background: ${bgAnalysis}
Scenario: ${contentVideo}
Do not use markdown blocks, return only raw JSON array like ["prompt 1", "prompt 2"].`;
  
  const res = await generateContentWithFallback(prompt);
  const raw = res.text.replace(/```json|```/g, '').trim();
  return JSON.parse(raw);
}

export async function generateVideoPrompts(numVideos, productName, contentVideo, imagePrompt) {
  const prompt = `Generate exactly ${numVideos} short Veo 3 video prompt single-line strings in a JSON schema: {"prompts": ["string1", "string2"]}.
Scenario: ${contentVideo}. Product: ${productName}. Initial Frame: ${imagePrompt}. Spoken language: Vietnamese (25-28 words). Final clip ends with: "xem ngay tại giỏ hàng bên góc trái bên dưới ạ". Output only raw JSON.`;

  const res = await generateContentWithFallback(prompt);
  const raw = res.text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(raw);
  return parsed.prompts || parsed;
}

export function createSmartFallbackCaption(productName, contentVideo, productAnalysis) {
  const pName = productName || 'sản phẩm';
  const cleanTag = pName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  
  const hooks = [
    `Đã tìm ra chân ái ${pName} siêu ưng ý cho mọi người đây ạ! ✨`,
    `Review chân thực em ${pName} dùng mê thực sự luôn nha! 😍`,
    `Ai đang tìm kiếm ${pName} chất lượng thì xem ngay video này nhé! 💯`
  ];
  const hook = hooks[Math.floor(Math.random() * hooks.length)];
  const body = contentVideo ? `${contentVideo}. ` : (productAnalysis ? `${productAnalysis}. ` : 'Trải nghiệm thực tế cực kỳ mượt mà, đúng chuẩn hàng xịn xò. ');
  const cta = '👉 Nhấn ngay vào giỏ hàng bên góc trái bên dưới màn hình để nhận ưu đãi hời hôm nay nha! 🛒👇';
  const tags = `#review #${cleanTag || 'sanpham'} #tiktokshop #muataitiktok #xuhuong #fyp`;

  return `${hook} ${body}${cta}\n\n${tags}`;
}

export async function generateCaption(arg) {
  let productName = '';
  let contentVideo = '';
  let productAnalysis = '';

  if (typeof arg === 'string') {
    productAnalysis = arg;
  } else if (arg && typeof arg === 'object') {
    productName = arg.productName || '';
    contentVideo = arg.contentVideo || '';
    productAnalysis = arg.productAnalysis || '';
  }

  const pName = productName || 'sản phẩm';
  const context = [
    pName ? `Tên sản phẩm: ${pName}` : '',
    contentVideo ? `Kịch bản/nội dung video: ${contentVideo}` : '',
    productAnalysis ? `Đặc điểm nổi bật: ${productAnalysis}` : ''
  ].filter(Boolean).join('\n');

  const prompt = `Bạn là chuyên gia sáng tạo nội dung TikTok Shop triệu view. Dựa vào thông tin sau:
${context}

Hãy viết 1 đoạn Caption đăng TikTok hoàn chỉnh, tự nhiên và cuốn hút:
1. Mở đầu bằng 1-2 câu hook hấp dẫn nói về công dụng hoặc sự yêu thích dành cho ${pName}.
2. Kèm lời kêu gọi xem giỏ hàng góc trái bên dưới nhận ưu đãi (ví dụ: "Xem ngay giỏ hàng góc trái bên dưới nhận ưu đãi nhé! 👇").
3. Thêm 2-3 icon sinh động.
4. Cuối bài kèm 5 hashtag TikTok Shop thịnh hành (bắt buộc có #review #${pName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '')} #tiktokshop #xuhuong).
Chỉ trả về đúng văn bản Caption hoàn chỉnh, không giải thích.`;

  try {
    const res = await generateContentWithFallback(prompt);
    const text = res.text?.trim();
    if (text && text.length > 20) return text;
  } catch (e) {
    console.warn(`[AI Caption] Lỗi gọi Gemini: ${e.message}. Sử dụng caption thông minh thay thế.`);
  }

  return createSmartFallbackCaption(productName, contentVideo, productAnalysis);
}

export const LOCKED_MODEL_PROFILE = "Một cô gái trẻ 20 tuổi người châu Á xinh đẹp, mặt trái xoan, da trắng sứ có tàn nhang nhẹ trên sống mũi và má hồng đào, mắt nâu hạnh nhân bọng mắt cười, môi son cherry, tóc xoăn lơi màu nâu đen có mái thưa bay nhẹ, mặc áo thun trắng đơn giản thanh lịch";

/**
 * Tạo danh sách prompt phân cảnh cho Google Vids (Omni Video Engine)
 * ĐỒNG NHẤT 100% nhân vật mẫu nữ đã chốt trên tất cả các clip ghép lại.
 * Định dạng cô đọng chuẩn Google Vids AI (< 80 từ/cảnh) để sinh video 1 shot mượt mà, không bị kẹt.
 */
export async function generateVidsPrompts(numVideos = 2, productName, contentVideo, productAnalysis, modelAnalysis, bgAnalysis, hasRefImages = false, script = '') {
  const count = Math.max(1, Math.min(numVideos, 3));

  // Nếu người dùng đã viết sẵn Kịch Bản trong Sheet, bám sát đúng nội dung/thoại đó thay vì
  // để AI tự bịa diễn biến — kịch bản được áp dụng cho MỌI clip vì các clip ghép lại thành 1
  // video liên tục nên cần cùng theo một mạch kịch bản. "Content Video" (ghi chú ngắn, nếu có
  // và không trùng Kịch Bản) được thêm làm ngữ cảnh bổ sung nhẹ.
  const trimmedScript = (script || '').trim();
  const trimmedContent = (contentVideo || '').trim();
  let guidanceClause = '';
  if (trimmedScript) {
    guidanceClause = `Bám sát đúng kịch bản sau cho diễn biến và lời thoại: "${trimmedScript}". `;
  } else if (trimmedContent) {
    guidanceClause = `Nội dung định hướng: "${trimmedContent}". `;
  }

  if (hasRefImages) {
    if (count === 1) {
      return [
        `${guidanceClause}Từ các hình ảnh nguyên liệu đã đính kèm: Hãy tạo 1 video review ${productName}. Trong đó: Người mẫu review chính bắt buộc phải có đúng diện mạo, khuôn mặt, mái tóc của ảnh chân dung người mẫu đính kèm; trên tay tự tin cầm và giới thiệu đúng mẫu sản phẩm trong ảnh đính kèm (giữ nguyên kiểu dáng, màu sắc, chi tiết sản phẩm); diễn ra trong không gian bối cảnh đính kèm. Mở đầu người mẫu cười tươi chào đón, trình diễn tính năng thực tế của sản phẩm, cuối video chỉ tay xuống giỏ hàng bên góc trái bên dưới kêu gọi mua sắm. Thuyết minh tiếng Việt hoàn toàn.`
      ];
    }

    const prompts = [
      // Clip 1: Mở đầu chào hỏi, giới thiệu tính năng dở dang (KHÔNG chào kết)
      `${guidanceClause}Từ các hình ảnh nguyên liệu đã đính kèm, hãy tạo đoạn video MỞ ĐẦU review ${productName}. QUAN TRỌNG NHẤT: người mẫu review bắt buộc phải có đúng diện mạo, khuôn mặt, mái tóc của ảnh chân dung người mẫu đã đính kèm; trên tay tự tin cầm và giới thiệu đúng mẫu sản phẩm trong ảnh đính kèm; bối cảnh không gian theo ảnh nền đính kèm. Người mẫu mở đầu chào đón người xem, hào hứng bắt đầu thử nghiệm tính năng nổi bật của sản phẩm. Giữ diễn biến đang diễn ra dở dang đầy tò mò, TUYỆT ĐỐI KHÔNG chào tạm biệt hay kết thúc video. Thuyết minh tiếng Việt cuốn hút.`,

      // Clip 2: Nối tiếp ngay cảnh trước (KHÔNG chào lại), trải nghiệm kết quả & Chốt đơn kết thúc
      `${guidanceClause}Từ các hình ảnh nguyên liệu đã đính kèm, hãy tạo đoạn video NỐI TIẾP VÀ KẾT THÚC của cảnh trước cho ${productName}. BẮT BUỘC GIỮ NGUYÊN 100% ĐÚNG DIỆN MẠO NGƯỜI MẪU và ĐÚNG MẪU SẢN PHẨM trong các ảnh đính kèm từ cảnh trước (tuyệt đối không thay đổi kiểu dáng, trang phục, diện mạo). Bắt đầu ngay bằng việc TIẾP TỤC thử nghiệm sản phẩm, KHÔNG chào hỏi lại từ đầu. Người mẫu gật đầu hài lòng trước hiệu quả vượt trội của sản phẩm, rồi cười rạng rỡ dùng tay chỉ vào giỏ hàng bên góc trái bên dưới màn hình kêu gọi đặt mua ngay, vẫy tay chào tạm biệt kết thúc video. Thuyết minh tiếng Việt: "Nhấn ngay vào giỏ hàng bên góc trái bên dưới để nhận ưu đãi nhé!".`,

      // Clip 3 (nếu có): Cận cảnh chi tiết bổ sung
      `${guidanceClause}Từ các hình ảnh nguyên liệu đã đính kèm, hãy tạo 1 video cận cảnh chất liệu của đúng mẫu sản phẩm đã đính kèm, cùng người mẫu trong ảnh chân dung đính kèm. Từng đường nét chi tiết tinh tế của sản phẩm hiển thị sắc nét, người mẫu mỉm cười ưng ý. Thuyết minh tiếng Việt hoàn toàn.`
    ];
    return prompts.slice(0, count);
  }

  // Chế độ văn bản (không có ảnh tham chiếu)
  const activeModel = LOCKED_MODEL_PROFILE;
  const activeBg = bgAnalysis || 'căn phòng hiện đại sang trọng, ánh sáng ấm áp dịu mắt';

  if (count === 1) {
    return [
      `${guidanceClause}Video quảng cáo dọc 9:16. ${activeModel}, đang ở trong ${activeBg}, trên tay cầm và tự tin giới thiệu sản phẩm ${productName}, trải nghiệm tính năng và cuối video hướng tay xuống giỏ hàng bên góc trái bên dưới. Thuyết minh tiếng Việt hoàn toàn.`
    ];
  }

  const prompts = [
    // Clip 1: Mở đầu và để ngỏ dở dang
    `${guidanceClause}Video quảng cáo dọc 9:16, góc quay trung. ${activeModel}, đang ở trong ${activeBg}, mở đầu tươi cười chào người xem và bắt đầu giới thiệu ${productName}, hào hứng bắt đầu thử nghiệm công năng của sản phẩm, diễn biến đang tiếp diễn dở dang, KHÔNG chào tạm biệt, KHÔNG kết thúc video. Thuyết minh tiếng Việt tự nhiên lôi cuốn.`,

    // Clip 2: Nối tiếp ngay lập tức & Chốt đơn kết thúc
    `${guidanceClause}Video quảng cáo dọc 9:16, góc quay cận trung. Đúng cô gái trẻ mặt trái xoan tàn nhang nhẹ tóc xoăn mái thưa mặc áo trắng đó, giữ nguyên trang phục và diện mạo, TIẾP TỤC trải nghiệm tính năng của ${productName} từ cảnh trước, KHÔNG chào lại từ đầu. Cô gái gật đầu ưng ý, cười tươi rạng rỡ và chỉ tay vào giỏ hàng bên góc trái bên dưới màn hình kêu gọi mua ngay, vẫy tay chào tạm biệt kết thúc video. Thuyết minh tiếng Việt: "Nhấn ngay vào giỏ hàng bên góc trái bên dưới nhé!".`,

    // Clip 3 (nếu có): Cận cảnh chi tiết
    `${guidanceClause}Video quảng cáo dọc 9:16, góc quay cận cảnh. Đúng cô gái đó trong ${activeBg}, nâng niu sản phẩm ${productName}, cận cảnh từng đường nét sắc nét, mỉm cười gật đầu hài lòng. Thuyết minh tiếng Việt hoàn toàn.`
  ];

  return prompts.slice(0, count);
}

export async function generateVidsPrompt(productName, contentVideo, productAnalysis, script = '') {
  const prompts = await generateVidsPrompts(1, productName, contentVideo, productAnalysis, null, null, false, script);
  return prompts[0];
}
