import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { supabase } from '@/lib/supabase';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

export async function POST(req: NextRequest) {
    try {
        const formData = await req.formData();
        const imageFiles = formData.getAll('images') as File[];

        if (!imageFiles || imageFiles.length === 0) {
            return NextResponse.json({ success: false, error: 'ไม่พบไฟล์รูปภาพ' }, { status: 400 });
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

      ⚠️ ย้ำอีกครั้ง: ราคาที่ return มาต้องเป็นราคาที่อยู่ในข้อความปักหมุดเท่านั้น ห้ามนำราคาจากแชทอื่นมาใส่เด็ดขาด
    `;

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [
                prompt,
                ...inlineDataParts
            ],
        });

        const aiText = response.text || '[]';
        let cleanJsonArray = JSON.parse(aiText.replace(/```json/g, '').replace(/```/g, '').trim());

        // Safety check if it returned a single object instead of array
        if (!Array.isArray(cleanJsonArray)) {
            if (cleanJsonArray.name) {
                cleanJsonArray = [cleanJsonArray];
            } else {
                cleanJsonArray = [];
            }
        }

        const dbInsertPayload = cleanJsonArray.map((cleanJson: any) => {
            if (!cleanJson.items) cleanJson.items = [];

            const itemsTotal = cleanJson.items.reduce((sum: number, item: any) => sum + (item.price || 0), 0);

            return {
                name: cleanJson.name,
                items: cleanJson.items,
                items_count: cleanJson.items.length,
                total_price: itemsTotal + 40, // บวกค่าส่ง 40 บาท ครั้งเดียวต่อลูกค้า
                status: 'PROCESSED'
            };
        });

        // Insert into Supabase
        const { data: dbData, error: dbError } = await supabase
            .from('customer_logs')
            .insert(dbInsertPayload)
            .select();

        if (dbError) {
            console.error('Supabase insert error:', dbError);
        }

        return NextResponse.json({ success: true, data: cleanJsonArray, dbData });

    } catch (error: any) {
        console.error('Server Error:', error);

        // Pass 429 status to client if rate limit is hit
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
            // ลบข้อมูลทั้งหมดใน customer_logs
            const { error } = await supabase.from('customer_logs').delete().neq('id', 0);
            if (error) console.error('Delete all error:', error);
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