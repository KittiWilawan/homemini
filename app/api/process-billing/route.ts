import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '@/lib/supabase';

// คลังแสงรวบรวมกุญแจวิชาแยกเงา 5 ร่าง
const apiKeys = [
    process.env.GEMINI_API_KEY_1 || '',
    process.env.GEMINI_API_KEY_2 || '',
    process.env.GEMINI_API_KEY_3 || '',
    process.env.GEMINI_API_KEY_4 || '',
    process.env.GEMINI_API_KEY_5 || ''
].filter(key => key !== '');

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const imageFiles = formData.getAll('images') as File[];

        if (!imageFiles || imageFiles.length === 0) {
            return NextResponse.json({ success: false, error: 'ไม่พบไฟล์รูปภาพ' }, { status: 400 });
        }

        if (apiKeys.length === 0) {
            return NextResponse.json({ success: false, error: 'ระบบตรวจสอบไม่พบคีย์กูเกิลในไฟล์ env' }, { status: 500 });
        }

        const prompt = `
      คุณคือระบบ AI สำหรับอ่านข้อมูลจาก "ข้อความปักหมุด" (Pinned Message) ในแชทเท่านั้น
      🚨🚨🚨 กฎเหล็กสำคัญที่สุด — ห้ามละเมิดเด็ดขาด:
      ❌ ห้ามอ่านข้อความแชทธรรมดา ห้ามเอาราคาจากข้อความที่ไม่ได้ปักหมุด
      ❌ ห้ามคิดราคาเอง ห้ามเดาราคา ห้ามคำนวณราคาเพิ่มเติม
      ❌ ห้ามเพิ่มค่าส่ง ห้ามรวมค่าจัดส่ง (ระบบจะเพิ่มค่าส่งเองทีหลัง)
      ❌ ห้ามเอาตัวเลขจาก timestamp, หมายเลขโทรศัพท์, วันที่, จำนวนชิ้น มาเป็นราคา

      ✅ สิ่งที่ต้องทำ:
      1. ดูเฉพาะ "ข้อความที่ถูกปักหมุด" (Pinned Message) เท่านั้น — จะมีสัญลักษณ์หมุดหรือแถบพิเศษระบุ
      2. จากข้อความปักหมุด ให้ดึง "ชื่อลูกค้า" ออกมา (ชื่อลูกค้าอาจเป็นชื่อจริง, ชื่อเล่น, หรือ username)
      3. จากข้อความปักหมุดเดียวกัน ให้ดึง "ราคาสินค้าแต่ละรายการ" ออกมา — ราคาคือตัวเลขที่เกี่ยวกับมูลค่าสินค้า (เช่น มีคำว่า บาท, ฿, ราคา, ยอด อยู่ใกล้ๆ)
      4. ถ้าปักหมุดมีรายการสินค้าหลายรายการ ให้ใส่แยกแต่ละ item พร้อมราคาของมัน
      5. ถ้ารูปไม่มีข้อความปักหมุด หรือไม่มีราคาในปักหมุด → ให้ return array ว่าง []

      📌 สรุป: ชื่อ = จากปักหมุด, ราคา = จากปักหมุดเท่านั้น, ไม่ต้องเพิ่มค่าส่ง

      ส่งข้อมูลกลับมาเป็น JSON Array เท่านั้น ห้ามมีข้อความอื่นใดนอกจาก JSON:
      [
        {
          "name": "ชื่อลูกค้า",
          "items": [
            { "type": "ชื่อสินค้า (ถ้ามี) หรือ product", "price": ราคาจากปักหมุดเท่านั้น }
          ]
        }
      ]
    `;

        const finalProcessedData: any[] = [];
        console.log(`[เซิร์ฟเวอร์] ได้รับรูปภาพทั้งหมด ${imageFiles.length} รูป เริ่มวนลูปประมวลผลบนคลาวด์...`);

        // 🔄 เปลี่ยนจุดนี้: ย้ายลูปประมวลผลรูปภาพจากหน้าบ้าน (มือถือ) มาให้หลังบ้าน (เซิร์ฟเวอร์) จัดการทีละรูป
        for (let i = 0; i < imageFiles.length; i++) {
            const file = imageFiles[i];
            const bytes = await file.arrayBuffer();
            const base64Data = Buffer.from(bytes).toString('base64');

            // จัดฟอร์แมตข้อมูลส่งให้ Gemini ทีละรูป
            const inlineDataParts = [{
                inlineData: {
                    data: base64Data,
                    mimeType: file.type
                }
            }];

            let response = null;
            let aiSuccess = false;

            // ⚡ ลูปสลับร่างเงา 5 คีย์กรณีติด Cooldown หรือเซิร์ฟเวอร์กูเกิลล่ม (รันเสถียรๆ อยู่บนคลาวด์)
            for (let k = 0; k < apiKeys.length; k++) {
                try {
                    console.log(`[คลาวด์คิว] รูปที่ ${i + 1}/${imageFiles.length} -> พยายามใช้กุญแจร่างเงาที่ ${k + 1}`);
                    const ai = new GoogleGenAI({ apiKey: apiKeys[k] });

                    response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: [prompt, ...inlineDataParts],
                    });

                    aiSuccess = true;
                    break; // สแกนผ่านแล้ว หลุดออกจากลูปเช็คคีย์เพื่อไปบันทึกข้อมูล

                } catch (error: any) {
                    const isRateLimit = error.status === 429 || error.message?.includes('429') || error.message?.includes('quota');
                    const isServerOverload = error.status === 503 || error.message?.includes('503') || error.message?.includes('UNAVAILABLE');

                    if (isRateLimit) {
                        console.warn(`⚠️ คีย์ที่ ${k + 1} ติดคูลดาวน์ (429) สลับไปคีย์ถัดไป...`);
                        continue;
                    } else if (isServerOverload) {
                        console.warn(`🔥 เซิร์ฟเวอร์กูเกิลหนาแน่น (503) หยุดตั้งหลัก 3 วินาที แล้วสลับคีย์...`);
                        await new Promise((resolve) => setTimeout(resolve, 3000));
                        continue;
                    } else {
                        console.error(`❌ คีย์ที่ ${k + 1} พังด้วยเหตุผลอื่น ข้ามไปคีย์ถัดไป...`);
                        continue;
                    }
                }
            }

            // ถ้ารูปนี้โชคร้ายจริงๆ สแกนไม่ผ่านทุกคีย์ ให้ข้ามรูปนี้ไปทำรูปถัดไป ระบบจะไม่ค้างตาย
            if (!aiSuccess || !response) {
                console.error(`💥 รูปที่ ${i + 1} สแกนไม่ผ่านทุกกุญแจ ข้ามรูปนี้ไปทำงานต่อ...`);
                continue;
            }

            // บันทึกและสะสมยอดเงินเข้าตารางฐานข้อมูล Supabase
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

                        const { data: updatedData } = await supabase
                            .from('customer_logs')
                            .update({
                                items: combinedItems,
                                items_count: combinedItems.length,
                                total_price: totalItemsPrice + 40,
                                status: 'PROCESSED'
                            })
                            .eq('id', oldRecord.id)
                            .select();

                        if (updatedData && updatedData[0]) finalProcessedData.push(updatedData[0]);
                    } else {
                        const itemsTotal = cleanJson.items.reduce((sum: number, item: any) => sum + (item.price || 0), 0);

                        const { data: insertedData } = await supabase
                            .from('customer_logs')
                            .insert({
                                name: cleanJson.name.trim(),
                                items: cleanJson.items,
                                items_count: cleanJson.items.length,
                                total_price: itemsTotal + 40,
                                status: 'PROCESSED'
                            })
                            .select();

                        if (insertedData && insertedData[0]) finalProcessedData.push(insertedData[0]);
                    }
                }
            } catch (jsonError) {
                console.error(`❌ รูปที่ ${i + 1} ถอดรหัส JSON ล้มเหลว ข้ามไปรูปถัดไป`);
            }
        }

        // ประมวลผลรูปภาพครบถ้วนแล้ว ส่งรายงานสรุปทั้งหมดกลับหน้าบ้าน
        return NextResponse.json({ success: true, dbData: finalProcessedData });

    } catch (error: any) {
        console.error('Server Critical Error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const body = await req.json();
        const { deleteAll } = body; // รับค่าคำสั่งล้างทั้งหมดจากหน้าบ้าน

        if (deleteAll) {
            const { error } = await supabase.rpc('truncate_customer_logs');

            if (error) throw error;
            console.log("💥 [เซิร์ฟเวอร์] สั่ง TRUNCATE ล้างตารางและรีเซ็ต ID นับ 1 ใหม่เรียบร้อยแล้ว!");
        }

        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error('Delete Error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}