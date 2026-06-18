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

        const inlineDataParts = await Promise.all(imageFiles.map(async (file) => {
            const bytes = await file.arrayBuffer();
            const base64Data = Buffer.from(bytes).toString('base64');
            return {
                inlineData: {
                    data: base64Data,
                    mimeType: file.type
                }
            };
        }));

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

        let response = null;
        let aiSuccess = false;

        // 🔄 ⚡ ลูปเวอร์ชันทรหด: สลับคีย์อัตโนมัติ + หน่วงเวลาตั้งหลักเผื่อเซิร์ฟเวอร์กูเกิลล่ม (503)
        for (let k = 0; k < apiKeys.length; k++) {
            try {
                console.log(`[ระบบคิว] พยายามใช้กุญแจร่างเงาที่ ${k + 1}/${apiKeys.length}`);
                const ai = new GoogleGenAI({ apiKey: apiKeys[k] });

                response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [prompt, ...inlineDataParts],
                });

                // ถ้ายิงสำเร็จเรียบร้อย
                aiSuccess = true;
                console.log(`✅ กุญแจร่างเงาที่ ${k + 1} ทำงานสำเร็จอย่างสมบูรณ์!`);
                break;

            } catch (error: any) {
                const isRateLimit = error.status === 429 || error.message?.includes('429') || error.message?.includes('quota');
                const isServerOverload = error.status === 503 || error.message?.includes('503') || error.message?.includes('UNAVAILABLE');

                if (isRateLimit) {
                    console.warn(`⚠️ กุญแจที่ ${k + 1} ติด Cooldown (429)! กำลังสลับไปใช้กุญแจถัดไป...`);
                    continue; // สลับไปคีย์ถัดไปทันที
                }

                else if (isServerOverload) {
                    // 🌟 ท่าแก้บั๊ก 503: ถ้าเซิร์ฟเวอร์กูเกิลคนใช้เยอะจัด ให้ใจเย็นๆ หยุดรอ 3 วินาที แล้วค่อยไปคีย์ถัดไป
                    console.warn(`🔥 เซิร์ฟเวอร์กูเกิลล่มชั่วคราว (503)! กำลังหยุดรอตั้งหลัก 3 วินาที แล้วจะสลับไปคีย์ถัดไป...`);
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                    continue;
                }

                else {
                    // เผื่อเจอ Error แปลกปลอมอื่นๆ ก็ให้อดทนสลับไปคีย์ถัดไป ดีกว่าปล่อยให้โปรแกรมค้างตายครับน้า
                    console.error(`❌ กุญแจที่ ${k + 1} เจอ Error อื่นๆ:`, error.message);
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                    continue;
                }
            }
        }
        // 🚨 ดักแก่: ถ้าลองครบทุกคีย์แล้วไม่มีตัวไหนผ่านเลย
        if (!aiSuccess || !response) {
            console.error('💥 หมดท่า! ร่างเงาทุกตัวติด Cooldown พร้อมกันทั้งหมด');
            return NextResponse.json({ success: false, error: 'กุญแจทุกดอกติดขัดชั่วคราว' }, { status: 429 });
        }

        // แปลงข้อมูลข้อความจาก AI เป็น JSON แบบปลอดภัย
        const aiText = response.text || '[]';
        let cleanJsonArray = JSON.parse(aiText.replace(/```json/g, '').replace(/```/g, '').trim());

        if (!Array.isArray(cleanJsonArray)) {
            cleanJsonArray = cleanJsonArray.name ? [cleanJsonArray] : [];
        }

        cleanJsonArray = cleanJsonArray.filter((item: any) => item && item.name && item.name.trim() !== '');

        const finalProcessedData: any[] = [];

        // 📊 บันทึกและสะสมยอดเงินเข้าฐานข้อมูล Supabase 
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
                const finalTotalPrice = totalItemsPrice + 40;

                const { data: updatedData } = await supabase
                    .from('customer_logs')
                    .update({
                        items: combinedItems,
                        items_count: combinedItems.length,
                        total_price: finalTotalPrice,
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

        // 🌟 จุดเปลี่ยนชีวิต: ส่งข้อมูลที่ประมวลผลเสร็จแล้วกลับไปแจ้งหน้าบ้านทันที เพื่อให้หน้าบ้านขยับคิวรูปถัดไปได้
        return NextResponse.json({ success: true, data: cleanJsonArray, dbData: finalProcessedData });

    } catch (error: any) {
        console.error('Server Critical Error:', error);
        // ส่งสถานะกลับไปหน้าบ้านเสมอ ห้ามปล่อยให้หน้าบ้านยืนงงค้างเติ่ง
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const body = await req.json();
        const { id, ids, deleteAll } = body;

        if (deleteAll) {
            const { error } = await supabase.from('customer_logs').delete().not('id', 'is', null);
            if (error) throw error;
        } else if (id) {
            await supabase.from('customer_logs').delete().eq('id', id);
        } else if (ids && Array.isArray(ids)) {
            await supabase.from('customer_logs').delete().in('id', ids);
        }
        return NextResponse.json({ success: true });
    } catch (error: any) {
        console.error('Delete Error:', error);
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}