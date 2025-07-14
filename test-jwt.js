const jwt = require('@tsndr/cloudflare-worker-jwt');

async function testJWT() {
    const secret = 'test-secret';
    const payload = { path: '/test123', exp: Math.floor(Date.now() / 1000) + 3600 };
    
    try {
        // 測試簽名
        const token = await jwt.sign(payload, secret);
        console.log('Token generated:', token);
        
        // 測試驗證
        const verified = await jwt.verify(token, secret);
        console.log('Verified result:', verified);
        console.log('Verified type:', typeof verified);
        
        // 嘗試解碼 token 來獲取 payload
        const decoded = jwt.decode(token);
        console.log('Decoded payload:', decoded);
        console.log('Decoded type:', typeof decoded);
        
        // 檢查是否有其他方法
        console.log('JWT library methods:', Object.getOwnPropertyNames(jwt));
        
    } catch (error) {
        console.error('Error:', error);
    }
}

testJWT(); 