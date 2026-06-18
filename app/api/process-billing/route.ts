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
      คุณคือระบบ AI อัจฉริยะสำหรับการสแกนบิลและแชทโดยเฉพาะ 
      ฉันได้แนบรูปภาพแคปหน้าจอมาให้คุณหลายรูป (อาจมี 1 รูปหรือมากกว่า)
      หน้าที่ของคุณคือวิเคราะห์ "ทุกรูปภาพ" ที่แนบมานี้ อย่างละเอียดและแม่นยำที่สุด

      🚨 กฎเหล็กที่ต้องปฏิบัติตามอย่างเคร่งครัด (ห้ามละเมิดเด็ดขาด):
      1. ให้คุณมองหาเฉพาะ "ข้อความที่ถูกปักหมุด" (Pinned Message) หรือข้อความหลักที่เด่นชัดที่สุดในแต่ละรูปเท่านั้น
      2. ต้องวิเคราะห์แยกแยะ "ชื่อลูกค้า" และ "ราคาสินค้าแต่ละชิ้น" ของแต่ละคนให้ถูกต้อง 100% 
      3. หากมีตัวเลขหลายตัว ให้พิจารณาบริบทว่าตัวเลขไหนคือราคา (เช่น มีคำว่า บาท, ฿, ราคา, ยอด, รับ)
      4. ข้อมูลของลูกค้าแต่ละรูปภาพ ให้แยกเป็น 1 Object
      5. ส่งข้อมูลกลับมาเป็น JSON "Array" เท่านั้น ตามรูปแบบที่กำหนดเป๊ะๆ ห้ามมีคำอธิบายอื่นใดนอกเหนือจาก JSON

      ตัวอย่าง JSON Array ที่ต้องการ (ตัวอย่างกรณีมีลูกค้า 2 คน):
      [
        {
          "name": "ชื่อลูกค้าคนที่ 1",
          "items": [
            { "type": "product", "price": 80 },
            { "type": "product", "price": 60 }
          ]
        },
        {
          "name": "ชื่อลูกค้าคนที่ 2",
          "items": [
            { "type": "product", "price": 120 }
          ]
        }
      ]
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
            // เพิ่มค่าจัดส่ง 40 บาททุกรายการ
            if (!cleanJson.items) cleanJson.items = [];
            cleanJson.items.push({ type: 'shipping', price: 40 });

            return {
                name: cleanJson.name,
                items: cleanJson.items,
                items_count: cleanJson.items.length,
                total_price: cleanJson.items.reduce((sum: number, item: any) => sum + (item.price || 0), 0),
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
        const { id, ids } = body;
        
        if (id) {
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