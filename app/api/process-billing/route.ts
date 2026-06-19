import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '@/lib/supabase';

const apiKeys = [
    process.env.GEMINI_API_KEY_1 || ''
].filter(key => key !== '');

// ===== ⏱️ Backoff รอ token refresh — Gemini free tier reset ทุก ~60 วินาที =====
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function callGeminiWithRetry(
    prompt: string,
    inlineDataParts: any[],
    imageIndex: number,
    totalImages: number
) {
    const maxAttempts = 5; // รวมทั้งหมดจะลองสูงสุด 5 ครั้ง
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
                        responseMimeType: 'application/json', // บังคับ JSON → ลด output token
                        temperature: 0, // deterministic → ไม่ฟุ่มเฟือย
                    }
                });

                return response; // สำเร็จ → ส่งกลับทันที
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

        // ลองทุกคีย์แล้วยังไม่ผ่าน → รอ token refresh แล้วลองใหม่
        if (attempt < maxAttempts) {
            const waitSec = Math.min(15 * attempt, 60); // 15, 30, 45, 60 วินาที
            console.log(`⏰ รอ ${waitSec} วินาที ให้ token reset... (ครั้งที่ ${attempt}/${maxAttempts})`);
            await sleep(waitSec * 1000);
        }
    }

    console.error(`💥 รูป ${imageIndex} ไม่ผ่านหลังลอง ${maxAttempts} ครั้ง — ข้ามไป`);
    return null;
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

        // ===== 🧠 Prompt v3 — สั้น กระชับ ประหยัด token =====
        const prompt = `อ่านเฉพาะ "ข้อความปักหมุด" (Pinned Message) ในรูป แล้วดึงชื่อลูกค้า+ราคาสินค้าแต่ละรายการ

กฎ:
- ดูเฉพาะข้อความปักหมุด (มีสัญลักษณ์หมุดหรือแถบพิเศษ)
- ห้ามเอาราคาจากแชทธรรมดา ห้ามเดาราคา ห้ามเพิ่มค่าส่ง
- ห้ามเอาเบอร์โทร/วันที่/เวลา/จำนวนชิ้นมาเป็นราคา
- ถ้าไม่มีปักหมุดหรือไม่มีราคา → ตอบ []

ตอบ JSON เท่านั้น: [{"name":"ชื่อ","items":[{"type":"สินค้า","price":ราคา}]}]`;

        console.log(`[เซิร์ฟเวอร์] ได้รับ ${imageFiles.length} รูป เริ่มประมวลผล...`);

        for (let i = 0; i < imageFiles.length; i++) {
            const file = imageFiles[i];
            const bytes = await file.arrayBuffer();
            const base64Data = Buffer.from(bytes).toString('base64');

            const inlineDataParts = [{
                inlineData: { data: base64Data, mimeType: file.type }
            }];

            // 🧠 เรียก AI พร้อม auto-retry + รอ token refresh
            const response = await callGeminiWithRetry(prompt, inlineDataParts, i + 1, imageFiles.length);

            if (!response) continue; // ลองหมดแล้วยังไม่ผ่าน → ข้ามรูปนี้

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

                    const { data: existingRecords } = await supabase
                        .from('customer_logs')
                        .select('*')
                        .eq('name', cleanJson.name.trim());

                    if (existingRecords && existingRecords.length > 0) {
                        const oldRecord = existingRecords[0];
                        const combinedItems = [...(oldRecord.items || []), ...cleanJson.items];
                        const totalItemsPrice = combinedItems.reduce((sum: number, item: any) => sum + (item.price || 0), 0);

                        await supabase
                            .from('customer_logs')
                            .update({
                                items: combinedItems,
                                items_count: combinedItems.length,
                                total_price: totalItemsPrice + 40,
                                status: 'PROCESSED'
                            })
                            .eq('id', oldRecord.id);
                    } else {
                        const itemsTotal = cleanJson.items.reduce((sum: number, item: any) => sum + (item.price || 0), 0);

                        await supabase
                            .from('customer_logs')
                            .insert({
                                name: cleanJson.name.trim(),
                                items: cleanJson.items,
                                items_count: cleanJson.items.length,
                                total_price: itemsTotal + 40,
                                status: 'PROCESSED'
                            });
                    }
                }
            } catch (jsonError) {
                console.error(`❌ รูปที่ ${i + 1} JSON ล้มเหลว ข้ามไป`);
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