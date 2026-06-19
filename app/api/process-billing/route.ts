import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '@/lib/supabase';

const apiKeys = [
    process.env.GEMINI_API_KEY_1 || ''
].filter(key => key !== '');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function callGeminiWithRetry(
    prompt: string,
    inlineDataParts: any[],
    imageIndex: number,
    totalImages: number
) {
    const maxAttempts = 5;
    let lastError: any = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        for (let k = 0; k < apiKeys.length; k++) {
            try {
                console.log(`[คิว] รูป ${imageIndex}/${totalImages} → คีย์ ${k + 1} (ครั้งที่ ${attempt})`);
                const ai = new GoogleGenAI({ apiKey: apiKeys[k] });

                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [prompt, ...inlineDataParts],
                    config: {
                        responseMimeType: 'application/json',
                        temperature: 0,
                    }
                });

                return response;
            } catch (error: any) {
                lastError = error;
                const is429 = error.status === 429 || error.message?.includes('429') || error.message?.includes('quota');
                const is503 = error.status === 503 || error.message?.includes('503');

                if (is429) {
                    console.warn(`⏳ คีย์ ${k + 1} token หมด (429) — สลับคีย์ถัดไป`);
                } else if (is503) {
                    console.warn(`🔥 เซิร์ฟเวอร์ Google ล่ม (503) — รอ 3 วิ`);
                    await sleep(3000);
                } else {
                    console.error(`❌ คีย์ ${k + 1} error อื่น:`, error.message);
                }
            }
        }

        if (attempt < maxAttempts) {
            const waitSec = Math.min(15 * attempt, 60); // 15, 30, 45, 60 วินาที
            console.log(`⏰ รอ ${waitSec} วินาที ให้ token reset... (ครั้งที่ ${attempt}/${maxAttempts})`);
            await sleep(waitSec * 1000);
        }
    }

    console.error(`💥 รูป ${imageIndex} ไม่ผ่านหลังลอง ${maxAttempts} ครั้ง — ข้ามไป`);
    return null;
}

// ===== 🧹 ฟังก์ชันเช็กชื่อคล้ายกัน (Fuzzy Match ป้องกันพิมพ์ตก/AI อ่านพลาด) =====
function levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    const matrix = Array(a.length + 1).fill(null).map(() => Array(b.length + 1).fill(null));
    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            const indicator = a[i - 1] === b[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1, // deletion
                matrix[i][j - 1] + 1, // insertion
                matrix[i - 1][j - 1] + indicator // substitution
            );
        }
    }
    return matrix[a.length][b.length];
}

function normalizeName(name: string): string {
    if (!name) return '';
    return name
        .toLowerCase()
        .replace(/[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2580-\u27BF]|\uD83E[\uDD10-\uDDFF]/g, '') // ลบ emoji
        .replace(/\s+/g, ' ')
        .trim();
}

function isSimilarName(name1: string, name2: string): boolean {
    const n1 = normalizeName(name1);
    const n2 = normalizeName(name2);
    if (n1 === n2) return true;
    
    // ถ้าชื่อยาวเกิน 3 ตัวอักษร และตัวสะกดเพี้ยนแค่ 1-2 ตัว ให้ถือว่าเป็นคนเดียวกัน (เช่น Wisanu กับ Wisnu)
    if (n1.length > 3 && n2.length > 3) {
        const distance = levenshteinDistance(n1, n2);
        const maxAllowed = Math.max(1, Math.floor(Math.min(n1.length, n2.length) / 4));
        if (distance <= maxAllowed) return true;
    }
    return false;
}

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const imageFiles = formData.getAll('images') as File[];

        if (!imageFiles || imageFiles.length === 0) {
            return NextResponse.json({ success: false, error: 'ไม่พบไฟล์รูปภาพ' }, { status: 400 });
        }
        if (apiKeys.length === 0) {
            return NextResponse.json({ success: false, error: 'ไม่พบ API key' }, { status: 500 });
        }

        // ===== 🧠 Prompt แบบเน้นเฉพาะ "ปักหมุด" + (Batch Mode) =====
        const prompt = `ฉันจะส่งรูปแคปหน้าจอหลายๆ รูปให้คุณ
หน้าที่ของคุณคือ ดึงชื่อลูกค้าและราคาสินค้าจาก "ข้อความปักหมุด (Pinned Message / Pinned Comment)" เท่านั้น! แล้วนำข้อมูลจากทุกรูปมา "รวมกัน" ให้เป็นสรุปเดียว

กฎเหล็กสำหรับการรวมข้อมูล (สำคัญมากห้ามฝ่าฝืน):
1. **ดูเฉพาะข้อความปักหมุด**: ห้ามดึงข้อมูลจากคอมเมนต์แชทธรรมดาเด็ดขาด! ให้สนใจแค่ข้อความที่มีสัญลักษณ์ปักหมุด (Pinned) หรืออยู่ตำแหน่งปักหมุดเท่านั้น
2. **เทียบรูปโปรไฟล์**: สังเกตรูปโปรไฟล์ของลูกค้าในข้อความปักหมุดแต่ละรูปให้ดี ถ้า "รูปโปรไฟล์เหมือนกัน" แต่ชื่อสะกดเพี้ยนไปนิดหน่อย (เช่น Wisanu กับ Wisnu) ให้ถือว่าเป็น "ลูกค้าคนเดียวกัน" และรวบยอดบิลเข้าด้วยกันเลย
3. **ชื่อลูกค้า**: ดึงชื่อตามที่ปรากฏ "ห้ามแปลภาษาไทยเป็นอังกฤษเด็ดขาด"
4. **สินค้าและราคา**: ดึงชื่อสินค้าและ "ราคาต่อชิ้น" จากปักหมุด ห้ามเอายอดรวมหรือจำนวนชิ้นมาใส่เป็นราคา
5. **ค่าส่ง**: ถ้าในปักหมุดมีคำว่าค่าส่ง ห้ามนำมานับเป็นสินค้าเด็ดขาด

ตอบกลับเป็น JSON Array โดยรวมยอดคนที่รูปโปรไฟล์/ชื่อเหมือนกันให้เรียบร้อย (ถ้าไม่มีรูปไหนมีปักหมุดเลยให้ตอบ []):
[{"name":"ชื่อลูกค้า","items":[{"type":"ชื่อสินค้า","price":ราคา}]}]`;

        console.log(`[เซิร์ฟเวอร์] ได้รับ ${imageFiles.length} รูป เริ่มประมวลผล (แบ่งทำทีละ 20 รูป)...`);

        const CHUNK_SIZE = 20; // 📦 แบ่งส่งให้ AI ทีละ 20 รูป เพื่อไม่ให้ AI เบลอและไม่หนักเกินไป

        for (let chunkStart = 0; chunkStart < imageFiles.length; chunkStart += CHUNK_SIZE) {
            const chunkFiles = imageFiles.slice(chunkStart, chunkStart + CHUNK_SIZE);
            console.log(`\n⏳ กำลังประมวลผล Batch ที่ ${Math.floor(chunkStart / CHUNK_SIZE) + 1} (${chunkFiles.length} รูป)...`);

            // 📦 เตรียมรูปภาพสำหรับ Batch นี้
            const inlineDataParts = [];
            for (let i = 0; i < chunkFiles.length; i++) {
                const file = chunkFiles[i];
                const bytes = await file.arrayBuffer();
                const base64Data = Buffer.from(bytes).toString('base64');
                inlineDataParts.push({
                    inlineData: { data: base64Data, mimeType: file.type }
                });
            }

            // 🧠 เรียก AI ส่งรูปรอบละชุด (Batch)
            const response = await callGeminiWithRetry(prompt, inlineDataParts, chunkStart + 1, imageFiles.length);

            if (response) {
                // บันทึกลง Supabase
                try {
                    const aiText = response.text || '[]';
                    let cleanJsonArray = JSON.parse(aiText.replace(/```json/g, '').replace(/```/g, '').trim());

                    if (!Array.isArray(cleanJsonArray)) {
                        cleanJsonArray = cleanJsonArray.name ? [cleanJsonArray] : [];
                    }

                    cleanJsonArray = cleanJsonArray.filter((item: any) => item && item.name && item.name.trim() !== '');

                    for (const cleanJson of cleanJsonArray) {
                        if (!cleanJson.items) cleanJson.items = [];

                        const rawName = cleanJson.name.trim();

                        // 🔍 ดึงข้อมูลจาก DB มาเช็ก Fuzzy Match กับของเดิมที่เคยมี
                        const { data: allRecords } = await supabase.from('customer_logs').select('*');
                        const oldRecord = allRecords?.find((record: any) => isSimilarName(record.name, rawName));

                        if (oldRecord) {
                            // 🛑 ป้องกันข้อมูลสินค้าซ้ำ (Deduplication)
                            const newUniqueItems = cleanJson.items.filter((newItem: any) => {
                                return !oldRecord.items.some((oldItem: any) =>
                                    oldItem.type === newItem.type && oldItem.price === newItem.price
                                );
                            });

                            // ถ้าไม่มีสินค้าใหม่เลย ให้ข้ามไป ไม่บวกค่าส่งซ้ำ
                            if (newUniqueItems.length === 0) continue;

                            const combinedItems = [...(oldRecord.items || []), ...newUniqueItems];
                            const totalItemsPrice = combinedItems.reduce((sum: number, item: any) => sum + (item.price || 0), 0);

                            await supabase
                                .from('customer_logs')
                                .update({
                                    items: combinedItems,
                                    items_count: combinedItems.length,
                                    total_price: totalItemsPrice + 40, // +40 ค่าส่งรอบเดียว
                                    status: 'PROCESSED'
                                })
                                .eq('id', oldRecord.id);
                        } else {
                            const itemsTotal = cleanJson.items.reduce((sum: number, item: any) => sum + (item.price || 0), 0);

                            await supabase
                                .from('customer_logs')
                                .insert({
                                    name: rawName, // เก็บชื่อที่ AI เลือกมาให้
                                    items: cleanJson.items,
                                    items_count: cleanJson.items.length,
                                    total_price: itemsTotal + 40,
                                    status: 'PROCESSED'
                                });
                        }
                    }
                } catch (jsonError) {
                    console.error(`❌ Parse JSON ล้มเหลวใน Batch ที่ ${Math.floor(chunkStart / CHUNK_SIZE) + 1}`, jsonError);
                }
            }
        }

        // ส่งข้อมูลทั้งหมดจาก DB กลับ (ไม่ใช่แค่ที่เพิ่งประมวลผล)
        const { data: allRecords } = await supabase
            .from('customer_logs')
            .select('*')
            .order('id', { ascending: true });

        console.log(`✅ เสร็จสิ้น — ข้อมูลทั้งหมด ${allRecords?.length || 0} records`);
        return NextResponse.json({ success: true, dbData: allRecords || [] });

    } catch (error: any) {
        console.error('Server Critical Error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

// GET — ดึงข้อมูลจาก DB (ใช้เมื่อ client กลับมาจากการสลับแอป)
export async function GET() {
    try {
        const { data, error } = await supabase
            .from('customer_logs')
            .select('*')
            .order('id', { ascending: true });

        if (error) throw error;
        return NextResponse.json({ success: true, dbData: data || [] });
    } catch (error: any) {
        console.error('GET Error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const body = await req.json();
        const { deleteAll } = body;

        if (deleteAll) {
            const { error } = await supabase.rpc('truncate_customer_logs');
            if (error) throw error;
            console.log("💥 TRUNCATE เรียบร้อย");
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error('Delete Error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}