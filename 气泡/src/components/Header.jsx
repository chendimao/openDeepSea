export function Header() {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-white sticky top-0 z-10">
      <div className="flex items-center gap-2">
        <span className="bg-green-500 text-white text-xs font-semibold px-2 py-0.5 rounded">前端</span>
        <span className="text-sm font-medium text-gray-800">前端执行者</span>
        <span className="text-sm text-gray-400">· 小小打工</span>
      </div>
      <div className="flex items-center gap-1 border border-gray-200 rounded-full px-3 py-1">
        <span className="text-xs text-gray-600">ACP · Claude-3.5</span>
        <svg className="w-3 h-3 text-gray-400 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </div>
  );
}
