import axios from 'axios';
import { CONFIG } from './config.js';
import { normalizeTikTokSession } from './tiktok.js';

// Cache danh sách sản phẩm trong Showcase trong 5 phút để tránh gọi API liên tục khi chạy hàng loạt
let showcaseCache = {
  products: null,
  total: 0,
  lastFetchedAt: 0
};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 phút

/**
 * Trích xuất headers và cookies từ session TikTok
 */
function getAuthContext(sessionJson) {
  const rawSession = (sessionJson || CONFIG.TIKTOK_SESSION_JSON || '').trim();
  const validJson = normalizeTikTokSession(rawSession);
  if (!validJson) {
    throw new Error('Chưa cấu hình hoặc Session TikTok không hợp lệ.');
  }

  const session = JSON.parse(validJson);
  let cookieHeader = '';
  if (session.http?.cookies) {
    cookieHeader = Object.entries(session.http.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  } else if (Array.isArray(session.cookies)) {
    cookieHeader = session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  const userAgent = session.http?.headers?.['User-Agent'] ||
    session.http?.headers?.['user-agent'] ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  return {
    headers: {
      'User-Agent': userAgent,
      'Cookie': cookieHeader,
      'Referer': 'https://www.tiktok.com/'
    }
  };
}

/**
 * Lấy toàn bộ danh sách sản phẩm hiện có trong Showcase (Sàn trưng bày) của kênh
 */
export async function getShowcaseProducts(sessionJson = null, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && showcaseCache.products && (now - showcaseCache.lastFetchedAt < CACHE_TTL_MS)) {
    return showcaseCache.products;
  }

  const { headers } = getAuthContext(sessionJson);
  let offset = 0;
  let allProducts = [];

  while (true) {
    const res = await axios.get(`https://shop.tiktok.com/api/v1/streamer_desktop/showcase_product/list?count=50&offset=${offset}`, {
      headers,
      timeout: 15000
    });

    if (res.data?.code !== 0) {
      throw new Error(`Lỗi tải danh sách Showcase: ${res.data?.message || 'Mã lỗi ' + res.data?.code}`);
    }

    const prods = res.data.data?.products || [];
    if (prods.length === 0) break;
    allProducts.push(...prods);
    offset += prods.length;
    if (offset >= (res.data.data?.total || 0)) break;
  }

  showcaseCache = {
    products: allProducts,
    total: allProducts.length,
    lastFetchedAt: now
  };

  return allProducts;
}

/**
 * Tự động thêm sản phẩm vào Showcase của kênh TikTok Shop
 */
export async function addProductToShowcase(productId, sessionJson = null) {
  if (!productId) {
    throw new Error('Thiếu ID Sản Phẩm cần thêm vào Showcase.');
  }

  const { headers } = getAuthContext(sessionJson);
  const cleanId = String(productId).trim();

  const res = await axios.post('https://shop.tiktok.com/api/v1/streamer_desktop/showcase_product/add', {
    product_id: cleanId
  }, {
    headers,
    timeout: 15000
  });

  if (res.data?.code === 0) {
    // Xóa cache để lần gọi tiếp theo làm mới danh sách
    showcaseCache.lastFetchedAt = 0;
    return {
      success: true,
      message: 'Thêm vào Showcase thành công',
      data: res.data.data
    };
  } else {
    return {
      success: false,
      message: res.data?.message || `Mã lỗi ${res.data?.code}`,
      code: res.data?.code
    };
  }
}

/**
 * Đảm bảo sản phẩm có trong Showcase trước khi đăng:
 * 1. Kiểm tra sản phẩm đã có trong Showcase chưa
 * 2. Nếu đã có -> Kiểm tra tồn kho (stock_num, stock_status)
 * 3. Nếu chưa có -> Tự động gọi API thêm vào sàn
 */
export async function ensureProductInShowcase({
  productId,
  productName = '',
  sessionJson = null,
  logger = (lvl, msg) => console.log(`[${lvl}] ${msg}`)
}) {
  if (!productId) return { inShowcase: false, inStock: true };

  const cleanId = String(productId).trim();

  try {
    logger('info', `🔍 Đang kiểm tra Showcase sàn trưng bày cho sản phẩm [${cleanId}]...`);
    const products = await getShowcaseProducts(sessionJson);
    const existing = products.find(p => String(p.product_id || p.id) === cleanId);

    if (existing) {
      const title = existing.title || existing.name || productName;
      const stockNum = existing.stock_num !== undefined ? existing.stock_num : null;
      const stockStatus = existing.stock_status; // 1: In stock, 2: Out of stock

      // Kiểm tra tình trạng kho hàng
      if (stockStatus === 2 || (stockNum !== null && stockNum <= 0)) {
        const warnMsg = `⚠️ CẢNH BÁO TỒN KHO: Sản phẩm "${title}" [ID: ${cleanId}] đã HẾT HÀNG trên TikTok Shop (tồn kho: 0). TikTok sẽ KHÔNG HIỂN THỊ giỏ hàng trên video này!`;
        logger('warning', warnMsg);
        return {
          inShowcase: true,
          inStock: false,
          stockNum: 0,
          title,
          warning: warnMsg
        };
      }

      logger('success', ` Sản phẩm "${title}" đã có sẵn trong Showcase và còn hàng (tồn kho: ${stockNum || 'Còn'}).`);
      return {
        inShowcase: true,
        inStock: true,
        stockNum,
        title
      };
    }

    // Chưa có trong sàn -> Tự động thêm vào sàn
    logger('info', `➕ Sản phẩm [ID: ${cleanId}] chưa có trong Showcase. Đang tự động thêm vào sàn...`);
    const addResult = await addProductToShowcase(cleanId, sessionJson);

    if (addResult.success) {
      logger('success', `🎉 Đã TỰ ĐỘNG THÊM thành công sản phẩm [ID: ${cleanId}] vào Showcase của kênh!`);
      return {
        inShowcase: true,
        inStock: true,
        newlyAdded: true,
        message: 'Đã tự động thêm vào sàn thành công'
      };
    } else {
      const errMsg = `⚠️ Không thể tự động thêm sản phẩm [ID: ${cleanId}] vào Showcase: ${addResult.message}. (Vui lòng kiểm tra sản phẩm có còn hoa hồng Affiliate hoặc sàn bị đầy 200 sản phẩm không).`;
      logger('warning', errMsg);
      return {
        inShowcase: false,
        inStock: false,
        error: errMsg
      };
    }

  } catch (err) {
    logger('warning', `⚠️ Không thể kiểm tra/thêm Showcase tự động: ${err.message}. Hệ thống sẽ tiếp tục tiến trình đăng.`);
    return {
      inShowcase: false,
      error: err.message
    };
  }
}
