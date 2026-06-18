'use client';

import React, { useState, useRef } from 'react';

interface CustomerLog {
  id: string;
  initials: string;
  name: string;
  itemsCount: number;
  status: 'PROCESSED' | 'PENDING' | 'FAILED';
  totalPrice: number;
  items: { type: string; price: number }[];
}

export default function DashboardPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [customerLogs, setCustomerLogs] = useState<CustomerLog[]>([]);
  const [searchQuery, setSearchQuery] = useState('');

  const handleDeleteLog = async (id: string) => {
    setCustomerLogs(prev => prev.filter(log => log.id !== id));
    try {
      await fetch('/api/process-billing', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      });
    } catch (err) { console.error(err); }
  };

  const handleClearAll = async () => {
    if (confirm('ยืนยันการล้างข้อมูลทั้งหมด? (รวมถึงข้อมูลใน Database)')) {
      setCustomerLogs([]);
      try {
        await fetch('/api/process-billing', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deleteAll: true })
        });
      } catch (err) { console.error(err); }
    }
  };

  const compressImage = async (file: File, maxWidth = 1080): Promise<File> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = (event) => {
        const img = new Image();
        img.src = event.target?.result as string;
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;
          if (width > maxWidth) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          }
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);
          canvas.toBlob((blob) => {
            if (blob) resolve(new File([blob], file.name, { type: 'image/jpeg' }));
            else resolve(file);
          }, 'image/jpeg', 0.7);
        };
        img.onerror = error => reject(error);
      };
      reader.onerror = error => reject(error);
    });
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!event.target.files) return;
    const filesArray = Array.from(event.target.files);

    setIsScanning(true);
    setProgress(0);

    try {
      // บีบอัดรูปทั้งหมดพร้อมกัน
      setProgress(10);
      const compressedFiles = await Promise.all(
        filesArray.map((file) => compressImage(file))
      );

      // ยัดทุกรูปลง FormData เดียว → ส่ง API ครั้งเดียว
      const formData = new FormData();
      compressedFiles.forEach((file) => formData.append('images', file));

      setProgress(30);
      const response = await fetch('/api/process-billing', {
        method: 'POST',
        body: formData,
      });

      if (response.status === 429) {
        alert('ถูกจำกัดการใช้งาน (Rate Limit) กรุณารอสักครู่แล้วลองใหม่');
        setIsScanning(false);
        return;
      }

      setProgress(80);
      const result = await response.json();

      if (result.success && Array.isArray(result.data)) {
        setCustomerLogs((prevLogs) => {
          let updatedLogs = [...prevLogs];

          result.data.forEach((customerData: any, index: number) => {
            const dbRow = (result.dbData && result.dbData[index]) ? result.dbData[index] : null;
            const existingIndex = updatedLogs.findIndex(log => log.name === customerData.name);

            if (existingIndex >= 0) {
              const existing = updatedLogs[existingIndex];
              const newItemsPrice = customerData.items.reduce((sum: number, item: any) => sum + item.price, 0);
              updatedLogs[existingIndex] = {
                ...existing,
                itemsCount: existing.itemsCount + customerData.items.length,
                totalPrice: existing.totalPrice + newItemsPrice, // ไม่บวกค่าส่งซ้ำ เพราะบวกไปแล้วตอนสร้างครั้งแรก
                items: [...existing.items, ...customerData.items]
              };
            } else {
              updatedLogs.push({
                id: dbRow ? dbRow.id.toString() : Date.now().toString() + Math.random().toString(36).substr(2, 5),
                initials: customerData.name.substring(0, 2).toUpperCase(),
                name: customerData.name,
                itemsCount: customerData.items.length,
                status: 'PROCESSED',
                totalPrice: customerData.items.reduce((sum: number, item: any) => sum + item.price, 0) + 40, // บวกค่าส่ง 40 บาท ครั้งเดียว
                items: customerData.items
              });
            }
          });
          return updatedLogs;
        });
      } else {
        console.error("API Error:", result.error || "Unexpected response format");
      }
    } catch (error) {
      console.error("Error scanning files:", error);
    }

    setProgress(100);
    setIsScanning(false);
  };

  return (
    <div className="min-h-screen bg-[#f8fafc] text-[#1e293b] pb-20 md:pb-0">
      <div className="flex flex-col md:flex-row min-h-screen">

        {/* SIDEBAR */}
        <aside className="hidden md:flex w-64 bg-[#0f172a] text-white p-6 flex-col justify-between shrink-0">
          <div>
            <div className="mb-8">
              <h2 className="text-xl font-bold tracking-tight">Enterprise Data</h2>
              <span className="text-xs text-[#94a3b8]">Management Console</span>
            </div>
            <nav className="space-y-2">
              <button className="w-full flex items-center gap-3 px-4 py-3 bg-[#2563eb] text-white rounded-lg font-medium text-sm">
                📊 Dashboard
              </button>

            </nav>
          </div>
          <div>
            <button className="w-full bg-[#e2e8f0] text-[#0f172a] font-semibold py-3 px-4 rounded-lg text-sm mb-4">
              + New Process
            </button>
          </div>
        </aside>

        {/* MAIN CONTENT */}
        <main className="flex-1 p-4 sm:p-6 md:p-10 max-w-7xl mx-auto w-full">
          <header className="flex justify-between items-center mb-8">
            <h1 className="text-2xl md:text-3xl font-bold text-[#0f172a]">DataFlow Pro</h1>
          </header>

          {/* STATS */}
          <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
            <div className="bg-white border border-[#e2e8f0] rounded-xl p-6 flex justify-between items-start shadow-sm">
              <div>
                <p className="text-xs font-semibold text-[#64748b] uppercase mb-1">Processed Customers</p>
                <h3 className="text-3xl font-bold text-[#0f172a]">{customerLogs.length} People</h3>
              </div>
              <div className="p-3 bg-[#eff6ff] text-[#2563eb] rounded-lg">👤</div>
            </div>

            <div className="bg-white border border-[#e2e8f0] rounded-xl p-6 flex justify-between items-start shadow-sm">
              <div>
                <p className="text-xs font-semibold text-[#64748b] uppercase mb-1">Scan Status</p>
                <h3 className="text-base font-bold text-[#0f172a] mt-2">
                  {isScanning ? `Processing... (${progress}%)` : 'Ready to Scan'}
                </h3>
              </div>
              <div className="p-3 bg-gray-50 rounded-lg">⚙️</div>
            </div>
          </section>

          {/* UPLOAD ZONE */}
          <section className="bg-white border border-[#e2e8f0] rounded-xl p-5 md:p-8 mb-8 shadow-sm">
            <div className="border-2 border-dashed border-[#cbd5e1] rounded-xl p-8 md:p-12 text-center bg-[#f8fafc]">
              <p className="text-sm font-semibold text-[#1e293b] mb-1">Drag and drop photos here</p>
              <p className="text-xs text-[#94a3b8] mb-6">เลือกรูปภาพพร้อมกันหลายๆ รูปเพื่อรันระบบคิวอัจฉริยะ</p>

              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isScanning}
                className="bg-black text-white font-medium text-xs px-5 py-2.5 rounded-lg disabled:bg-gray-400"
              >
                {isScanning ? `Processing (${progress}%)` : '✨ Process Images'}
              </button>
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                multiple
                accept="image/*"
                className="hidden"
              />
            </div>
          </section>

          {/* LOG TABLE */}
          <section className="bg-white border border-[#e2e8f0] rounded-xl p-5 md:p-6 shadow-sm overflow-hidden">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
              <h3 className="text-base font-bold text-[#0f172a]">Customer Processing Log</h3>
              <div className="flex items-center gap-2 w-full sm:w-auto">
                <input
                  type="text"
                  placeholder="🔍 ค้นหาชื่อลูกค้า..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="border border-[#e2e8f0] rounded-lg px-3 py-1.5 text-sm w-full sm:w-64 focus:outline-none focus:border-[#2563eb]"
                />
                <button onClick={handleClearAll} className="text-xs bg-red-50 text-red-600 hover:bg-red-100 px-3 py-2 rounded-lg font-medium transition-colors shrink-0">
                  🗑️ Clear All
                </button>
              </div>
            </div>
            <div className="overflow-x-auto -mx-5 md:mx-0">
              <table className="w-full min-w-[600px] text-left">
                <thead>
                  <tr className="border-b border-[#e2e8f0] text-[10px] text-[#64748b] uppercase">
                    <th className="px-5 py-3">Customer Name</th>
                    <th className="px-5 py-3">Items Purchased</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">Total Price</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#f1f5f9]">
                  {customerLogs
                    .filter(log => log.name.toLowerCase().includes(searchQuery.toLowerCase()))
                    .map((log) => (
                      <tr key={log.id} className="text-sm">
                        <td className="px-5 py-4 font-semibold text-[#0f172a] flex items-center gap-2">
                          <button
                            onClick={() => {
                              const prices = log.items.map((item: any) => item.price);
                              const text = `${prices.join('+')}+40=${log.totalPrice}`;
                              navigator.clipboard.writeText(text);
                              alert(`คัดลอก: ${text}`);
                            }}
                            className="text-[10px] bg-[#f1f5f9] hover:bg-[#e2e8f0] text-[#475569] px-2 py-1 rounded transition-colors shrink-0"
                            title="Copy calculation"
                          >
                            📋
                          </button>
                          <span className="w-8 h-8 rounded bg-gray-100 flex items-center justify-center text-xs shrink-0">{log.initials}</span>
                          {log.name}
                        </td>
                        <td className="px-5 py-4 text-[#475569]">{log.itemsCount} Items</td>
                        <td className="px-5 py-4">
                          <span className="text-[10px] font-bold bg-[#dcfce7] text-[#15803d] px-2 py-1 rounded-full">● {log.status}</span>
                        </td>
                        <td className="px-5 py-4 font-bold">
                          {log.totalPrice.toLocaleString()} บาท
                        </td>
                      </tr>

                    ))}
                  {customerLogs.length === 0 && (
                    <tr>
                      <td colSpan={4} className="text-center py-10 text-xs text-gray-400">ยังไม่มีข้อมูลอัปโหลด กรุณาเลือกไฟล์เพื่อส่งให้ AI สแกนบิล</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </main>
      </div>

      {/* MOBILE BOTTOM NAV */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-[#0f172a] p-2 flex justify-around text-white text-[10px] z-50">
        <button className="text-[#2563eb]">📊<br />Dashboard</button>
      </nav>
    </div>
  );
}