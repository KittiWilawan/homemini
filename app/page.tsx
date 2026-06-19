'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';

interface CustomerLog {
  id: string;
  initials: string;
  name: string;
  itemsCount: number;
  status: 'PROCESSED' | 'PENDING' | 'FAILED';
  totalPrice: number;
  items: { type: string; price: number }[];
}

type MobileTab = 'dashboard' | 'customers';

export default function DashboardPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [customerLogs, setCustomerLogs] = useState<CustomerLog[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<MobileTab>('dashboard');

  // ===== 🔄 โหลดข้อมูลจาก DB =====
  const loadDataFromDB = useCallback(async () => {
    try {
      const res = await fetch('/api/process-billing');
      if (!res.ok) return;
      const result = await res.json();
      if (result.success && Array.isArray(result.dbData)) {
        setCustomerLogs(result.dbData.map((dbRow: any) => ({
          id: dbRow.id.toString(),
          initials: dbRow.name.substring(0, 2).toUpperCase(),
          name: dbRow.name,
          itemsCount: dbRow.items_count,
          status: dbRow.status,
          totalPrice: dbRow.total_price,
          items: dbRow.items || []
        })));
      }
    } catch (err) { console.error('Load error:', err); }
  }, []);

  // โหลดข้อมูลตอนเปิดหน้าเว็บ
  useEffect(() => { loadDataFromDB(); }, [loadDataFromDB]);

  // ===== 📱 เมื่อกลับมาจากการสลับแอป/เกม → โหลดข้อมูลใหม่จาก DB อัตโนมัติ =====
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('📱 กลับมาจากแอปอื่น → ดึงข้อมูลล่าสุดจาก DB...');
        loadDataFromDB();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [loadDataFromDB]);

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

  // ===== 📸 บีบอัดรูปลดขนาด ให้ส่งขึ้นเซิร์ฟเวอร์ได้เร็วที่สุดก่อนสลับแอป =====
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
    setProgress(10);

    try {
      // 📸 1. บีบอัดรูปก่อนส่ง (เร็วมาก)
      const compressedFiles = await Promise.all(
        filesArray.map(file => compressImage(file))
      );
      setProgress(25);

      const formData = new FormData();
      compressedFiles.forEach((file) => formData.append('images', file));

      // 🚀 2. ยิงขึ้นเซิร์ฟเวอร์ตูมเดียว!
      // (ถึงจุดนี้ต่อให้พับจอไปเล่นเกม เซิร์ฟเวอร์บน Cloud ก็จะทำงานต่อให้จนจบ)
      const response = await fetch('/api/process-billing', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error("อัปโหลดล้มเหลว");
      const result = await response.json();

      if (result.success && Array.isArray(result.dbData)) {
        setCustomerLogs(result.dbData.map((dbRow: any) => ({
          id: dbRow.id.toString(),
          initials: dbRow.name.substring(0, 2).toUpperCase(),
          name: dbRow.name,
          itemsCount: dbRow.items_count,
          status: dbRow.status,
          totalPrice: dbRow.total_price,
          items: dbRow.items || []
        })));
      }

    } catch (error) {
      console.error("Error sending files:", error);
      // ถ้า fetch ขาดเพราะพับจอเล่นเกมไปนาน → ไม่เป็นไร เซิร์ฟเวอร์ทำเสร็จแล้ว แค่โหลดใหม่
      console.log('🔄 การเชื่อมต่อขาดตอน ดึงข้อมูลใหม่จาก DB...');
      await loadDataFromDB();
    }

    setProgress(100);
    setIsScanning(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const filteredLogs = customerLogs.filter(log =>
    log.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-[#f8fafc] text-[#1e293b] pb-20 md:pb-0">
      <div className="flex flex-col md:flex-row min-h-screen">

        {/* SIDEBAR (Desktop) */}
        <aside className="hidden md:flex w-64 bg-[#0f172a] text-white p-6 flex-col justify-between shrink-0">
          <div>
            <div className="mb-8">
              <h2 className="text-xl font-bold tracking-tight">HomeMini Pro</h2>
              <span className="text-xs text-[#94a3b8]">AI Billing System</span>
            </div>
            <nav className="space-y-2">
              <button className="w-full flex items-center gap-3 px-4 py-3 bg-[#2563eb] text-white rounded-lg font-medium text-sm">
                📊 Dashboard
              </button>
            </nav>
          </div>
          <div>
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full bg-[#e2e8f0] text-[#0f172a] font-semibold py-3 px-4 rounded-lg text-sm mb-4 transition hover:bg-white"
            >
              + สแกนบิลใหม่
            </button>
          </div>
        </aside>

        {/* MAIN CONTENT */}
        <main className="flex-1 p-4 sm:p-6 md:p-10 max-w-7xl mx-auto w-full">
          <header className="flex justify-between items-center mb-6 md:mb-8">
            <h1 className="text-2xl md:text-3xl font-bold text-[#0f172a]">DataFlow Pro</h1>
          </header>

          {/* ===== 📱 TAB CONTENT: DASHBOARD ===== */}
          <div className={`${activeTab === 'dashboard' ? 'block' : 'hidden'} md:block`}>
            {/* STATS */}
            <section className="grid grid-cols-2 lg:grid-cols-3 gap-3 md:gap-6 mb-6 md:mb-8">
              <div className="bg-white border border-[#e2e8f0] rounded-xl p-4 md:p-6 flex flex-col md:flex-row justify-between items-start shadow-sm">
                <div>
                  <p className="text-[10px] md:text-xs font-semibold text-[#64748b] uppercase mb-1">ลูกค้าทั้งหมด</p>
                  <h3 className="text-2xl md:text-3xl font-bold text-[#0f172a]">{customerLogs.length} <span className="text-sm font-normal">คน</span></h3>
                </div>
                <div className="hidden md:flex p-3 bg-[#eff6ff] text-[#2563eb] rounded-lg mt-2 md:mt-0">👤</div>
              </div>

              <div className="bg-white border border-[#e2e8f0] rounded-xl p-4 md:p-6 flex flex-col md:flex-row justify-between items-start shadow-sm">
                <div>
                  <p className="text-[10px] md:text-xs font-semibold text-[#64748b] uppercase mb-1">ยอดรวมทั้งหมด</p>
                  <h3 className="text-2xl md:text-3xl font-bold text-[#0f172a]">
                    {customerLogs.reduce((sum, log) => sum + log.totalPrice, 0).toLocaleString()} <span className="text-sm font-normal">฿</span>
                  </h3>
                </div>
                <div className="hidden md:flex p-3 bg-green-50 text-green-600 rounded-lg mt-2 md:mt-0">💰</div>
              </div>

              <div className="bg-white border border-[#e2e8f0] rounded-xl p-4 md:p-6 flex flex-col md:flex-row justify-between items-start shadow-sm col-span-2 lg:col-span-1">
                <div>
                  <p className="text-[10px] md:text-xs font-semibold text-[#64748b] uppercase mb-1">สถานะระบบ AI</p>
                  <h3 className={`text-base md:text-lg font-bold mt-1 md:mt-2 ${isScanning ? 'text-amber-500' : 'text-emerald-500'}`}>
                    {isScanning ? `กำลังประมวลผล... (${progress}%)` : '✨ พร้อมสแกนบิล'}
                  </h3>
                  {isScanning && (
                    <div className="w-full bg-gray-200 rounded-full h-1.5 mt-3">
                      <div className="bg-amber-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* UPLOAD ZONE */}
            <section className="bg-white border border-[#e2e8f0] rounded-xl p-4 md:p-8 mb-6 md:mb-8 shadow-sm">
              <div
                className={`border-2 border-dashed rounded-xl p-8 md:p-12 text-center transition-colors ${isScanning ? 'border-amber-300 bg-amber-50' : 'border-[#cbd5e1] bg-[#f8fafc] hover:border-[#2563eb] hover:bg-[#eff6ff]'}`}
              >
                <div className="text-4xl mb-3">{isScanning ? '⏳' : '📸'}</div>
                <p className="text-sm font-semibold text-[#1e293b] mb-1">
                  {isScanning ? 'กำลังส่งข้อมูลไปให้ AI...' : 'อัปโหลดรูปบิลที่นี่'}
                </p>
                <p className="text-xs text-[#94a3b8] mb-6">
                  {isScanning ? 'สามารถพับจอไปเล่นเกมได้เลย ระบบจะทำงานต่ออัตโนมัติ' : 'เลือกรูปภาพพร้อมกันหลายๆ รูปเพื่อสแกนทีเดียว'}
                </p>

                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isScanning}
                  className="bg-[#0f172a] hover:bg-[#2563eb] active:scale-95 text-white font-medium text-sm px-6 py-3 rounded-lg disabled:bg-gray-400 disabled:transform-none transition-all shadow-md"
                >
                  {isScanning ? `ระบบกำลังทำงาน (${progress}%)` : '✨ เลือกรูปภาพ (สแกนได้หลายรูป)'}
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
          </div>

          {/* ===== 📱 TAB CONTENT: CUSTOMERS ===== */}
          <div className={`${activeTab === 'customers' ? 'block' : 'hidden'} md:block`}>
            {/* LOG SECTION */}
            <section className="bg-white border border-[#e2e8f0] rounded-xl p-4 md:p-6 shadow-sm overflow-hidden min-h-[400px]">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
                <h3 className="text-base font-bold text-[#0f172a] flex items-center gap-2">
                  📋 รายชื่อลูกค้า
                  <span className="bg-[#2563eb] text-white text-[10px] px-2 py-0.5 rounded-full">{filteredLogs.length}</span>
                </h3>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <div className="relative w-full sm:w-64">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-xs">🔍</span>
                    <input
                      type="text"
                      placeholder="ค้นหาชื่อ..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="border border-[#e2e8f0] rounded-lg pl-8 pr-3 py-2 text-sm w-full focus:outline-none focus:border-[#2563eb] bg-gray-50"
                    />
                  </div>
                  <button onClick={handleClearAll} className="text-xs bg-red-50 text-red-600 hover:bg-red-100 px-3 py-2.5 rounded-lg font-medium transition-colors shrink-0">
                    🗑️ ล้างทั้งหมด
                  </button>
                </div>
              </div>

              {/* 📱 Mobile View: Cards */}
              <div className="md:hidden flex flex-col gap-3">
                {filteredLogs.map((log) => (
                  <div key={log.id} className="border border-gray-100 rounded-xl p-4 shadow-sm bg-white relative">
                    <div className="flex items-center gap-3 mb-3">
                      <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-white flex items-center justify-center font-bold text-sm shrink-0 shadow-sm">
                        {log.initials}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h4 className="font-bold text-[#0f172a] text-sm truncate">{log.name}</h4>
                        <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full inline-block mt-1">
                          ● {log.status}
                        </span>
                      </div>
                      <button
                        onClick={() => {
                          const prices = log.items.map((item: any) => item.price);
                          const text = `${prices.join('+')}+40=${log.totalPrice}`;
                          navigator.clipboard.writeText(text);
                          alert(`คัดลอก: ${text}`);
                        }}
                        className="w-8 h-8 flex items-center justify-center bg-gray-100 hover:bg-gray-200 rounded-lg text-sm transition-colors"
                      >
                        📋
                      </button>
                    </div>

                    <div className="bg-gray-50 rounded-lg p-3 space-y-2 mb-3">
                      {log.items.map((item, idx) => (
                        <div key={idx} className="flex justify-between text-xs">
                          <span className="text-gray-600 truncate mr-2">{item.type || 'สินค้า'}</span>
                          <span className="font-semibold text-gray-800">{item.price} ฿</span>
                        </div>
                      ))}
                      <div className="flex justify-between text-xs pt-2 border-t border-gray-200 border-dashed">
                        <span className="text-gray-500">ค่าส่ง</span>
                        <span className="font-semibold text-gray-500">40 ฿</span>
                      </div>
                    </div>

                    <div className="flex justify-between items-center pt-2 border-t border-gray-100">
                      <span className="text-xs text-gray-500">{log.itemsCount} รายการ</span>
                      <span className="font-bold text-lg text-[#0f172a]">{log.totalPrice.toLocaleString()} ฿</span>
                    </div>
                  </div>
                ))}

                {filteredLogs.length === 0 && (
                  <div className="text-center py-12 text-gray-400 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                    <div className="text-3xl mb-2">📭</div>
                    <p className="text-xs">{searchQuery ? 'ไม่พบชื่อลูกค้าที่ค้นหา' : 'ยังไม่มีข้อมูลบิล กรุณาอัปโหลดรูปภาพ'}</p>
                  </div>
                )}
              </div>

              {/* 💻 Desktop View: Table */}
              <div className="hidden md:block overflow-x-auto -mx-5 md:mx-0">
                <table className="w-full min-w-[600px] text-left">
                  <thead>
                    <tr className="border-b border-[#e2e8f0] text-[10px] text-[#64748b] uppercase bg-gray-50">
                      <th className="px-5 py-3 rounded-tl-lg">ชื่อลูกค้า</th>
                      <th className="px-5 py-3">จำนวนรายการ</th>
                      <th className="px-5 py-3">สถานะ</th>
                      <th className="px-5 py-3 rounded-tr-lg">ยอดรวมสุทธิ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f1f5f9]">
                    {filteredLogs.map((log) => (
                      <tr key={log.id} className="text-sm hover:bg-gray-50 transition-colors">
                        <td className="px-5 py-4 font-semibold text-[#0f172a] flex items-center gap-3">
                          <button
                            onClick={() => {
                              const prices = log.items.map((item: any) => item.price);
                              const text = `${prices.join('+')}+40=${log.totalPrice}`;
                              navigator.clipboard.writeText(text);
                              alert(`คัดลอก: ${text}`);
                            }}
                            className="w-7 h-7 flex items-center justify-center bg-[#f1f5f9] hover:bg-[#e2e8f0] text-[#475569] rounded transition-colors shrink-0"
                            title="คัดลอกยอด"
                          >
                            📋
                          </button>
                          <span className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-xs font-bold text-white shrink-0 shadow-sm">{log.initials}</span>
                          {log.name}
                        </td>
                        <td className="px-5 py-4 text-[#475569]">
                          <span className="font-medium">{log.itemsCount}</span> ชิ้น
                        </td>
                        <td className="px-5 py-4">
                          <span className="text-[10px] font-bold bg-[#dcfce7] text-[#15803d] px-2.5 py-1 rounded-full border border-green-100">● {log.status}</span>
                        </td>
                        <td className="px-5 py-4 font-bold text-base text-[#0f172a]">
                          {log.totalPrice.toLocaleString()} <span className="text-xs font-normal text-gray-500">฿</span>
                        </td>
                      </tr>
                    ))}
                    {filteredLogs.length === 0 && (
                      <tr>
                        <td colSpan={4} className="text-center py-16 text-sm text-gray-400 bg-gray-50 rounded-b-lg border-t border-dashed border-gray-200">
                          <div className="text-4xl mb-3 opacity-50">📭</div>
                          {searchQuery ? 'ไม่พบชื่อลูกค้าที่ค้นหา' : 'ยังไม่มีข้อมูลอัปโหลด กรุณาเลือกไฟล์เพื่อส่งให้ AI สแกนบิล'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </main>
      </div>

      {/* 📱 MOBILE BOTTOM NAV */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 p-2 pb-[calc(8px+env(safe-area-inset-bottom))] flex justify-around shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)] z-50">
        <button
          onClick={() => setActiveTab('dashboard')}
          className={`flex-1 flex flex-col items-center gap-1 p-2 rounded-xl transition-all ${activeTab === 'dashboard' ? 'text-[#2563eb] bg-blue-50' : 'text-gray-400'}`}
        >
          <span className="text-xl leading-none">📊</span>
          <span className="text-[10px] font-bold">อัปโหลด & สถิติ</span>
        </button>
        <button
          onClick={() => setActiveTab('customers')}
          className={`flex-1 flex flex-col items-center gap-1 p-2 rounded-xl transition-all relative ${activeTab === 'customers' ? 'text-[#2563eb] bg-blue-50' : 'text-gray-400'}`}
        >
          <span className="text-xl leading-none">📋</span>
          <span className="text-[10px] font-bold">รายชื่อลูกค้า</span>
          {customerLogs.length > 0 && (
            <span className="absolute top-1 right-1/4 translate-x-2 w-4 h-4 flex items-center justify-center bg-red-500 text-white text-[8px] font-bold rounded-full border border-white">
              {customerLogs.length}
            </span>
          )}
        </button>
      </nav>
    </div>
  );
}