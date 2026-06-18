import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '@/lib/supabase';

// 🌟 ขั้นตอนที่ 1: คลังแสงรวบรวมกุญแจวิชาแยกเงา 5 ร่าง (ดึงมาจากไฟล์ .env.local)
const apiKeys = [
    process.env.GEMINI_API_KEY_1 || '',
    process.env.GEMINI_API_KEY_2 || '',
    process.env.GEMINI_API_KEY_3 || '',
    process.env.GEMINI_API_KEY_4 || '',
    process.env.GEMINI_API_KEY_5 || ''
].filter(key => key !== ''); // กรองเอาเฉพาะคีย์ที่มีการกรอกข้อมูลไว้จริง

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const imageFiles = formData.getAll('images') as File[];

        if (!imageFiles || imageFiles.length === 0) {
            return NextResponse.json({ success: false, error: 'ไม่พบไฟล์รูปภาพ' }, { status: 400 });
        }

        // 🚨 แจ้งเตือนความปลอดภัย เผื่อน้ายังไม่ได้ตั้งค่าคีย์ในไฟล์ .env.local
        if (apiKeys.length === 0) {
            return NextResponse.json({ success: false, error: 'ระบบตรวจสอบไม่พบคีย์กูเกิลในไฟล์ env' }, { status: 500 });
        }

        // 🌟 ขั้นตอนที่ 2: คาถาแยกเงาพันร่าง! สุ่มหยิบกุญแจ 1 ใน 5 ใบขึ้นมาประมวลผลรูปในรอบนี้
        const randomKey = apiKeys[Math.floor(Math.random() * apiKeys.length)];
        const ai = new GoogleGenAI({ apiKey: randomKey });

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
      
      ⚠️ ย้ำอีกครั้ง: ราคาที่ return มาต้องเป็นราคาที่อยู่ในข้อความปักหมุดเท่านั้น ห้ามนำราคาจากแชทอื่นมาใส่เด็ดขาด
    `;

        // 🌟 รันผ่านโมเดล 2.5-flash ตัวหลักด้วยกุญแจที่สุ่มขึ้นมาเมื่อกี้
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [prompt, ...inlineDataParts],
        });

        const aiText = response.text || '[]';
        let cleanJsonArray = JSON.parse(aiText.replace(/```json/g, '').replace(/```/g, '').trim());

        if (!Array.isArray(cleanJsonArray)) {
            cleanJsonArray = cleanJsonArray.name ? [cleanJsonArray] : [];
        }

        // กรองเอาเฉพาะข้อมูลที่มีชื่อคนจริงๆ ป้องกัน Array ว่างเปล่าทำหน้าเว็บล่ม
        cleanJsonArray = cleanJsonArray.filter((item: any) => item && item.name && item.name.trim() !== '');

        const finalProcessedData: any[] = [];

        // 🌟 ขั้นตอนที่ 3: ปรับโครงสร้างลูปใหม่เพื่อ "ป้องกันข้อมูลซ้ำ" และ "รวมยอดสะสม" เข้า Supabase
        for (const cleanJson of cleanJsonArray) {
            if (!cleanJson.items) cleanJson.items = [];

            // 🔍 ไปค้นหาในตารางก่อนว่าวันนี้เคยเก็บเงินของลูกค้าชื่อนี้ไปแล้วหรือยัง
            const { data: existingRecords } = await supabase
                .from('customer_logs')
                .select('*')
                .eq('name', cleanJson.name.trim());

            if (existingRecords && existingRecords.length > 0) {
                // 📝 เจอคนเดิม! จัดการรวบรวมของเก่าและของใหม่เข้าด้วยกัน
                const oldRecord = existingRecords[0];
                const combinedItems = [...(oldRecord.items || []), ...cleanJson.items];
                const totalItemsPrice = combinedItems.reduce((sum: number, item: any) => sum + (item.price || 0), 0);

                // คำนวณยอดรวมสินค้าทั้งหมด แล้วบวกค่าส่งปิดท้าย 40 บาททีเดียว
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
                // 🆕 ลูกค้าใหม่แกะกล่อง! ยิงบันทึกแถวใหม่เข้าไปในระบบปกติ
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

        // คืนค่าผลลัพธ์ข้อมูลล่าสุดใน Database (dbData) กลับไปโชว์ที่หน้า Dashboard
        return NextResponse.json({ success: true, data: cleanJsonArray, dbData: finalProcessedData });

    } catch (error: any) {
        console.error('Server Error:', error);
        if (error.status === 429 || error.message?.includes('429') || error.message?.includes('quota')) {
            return NextResponse.json({ success: false, error: error.message }, { status: 429 });
        }
        return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }
}

export async function DELETE(req: NextRequest) {
    try {
        const body = await req.json();
        const { id, ids, deleteAll } = body;

        if (deleteAll) {
            // ปรับคำสั่งล้างข้อมูลทั้งหมดให้ปลอดภัยและทำงานได้จริงบน PostgreSQL
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