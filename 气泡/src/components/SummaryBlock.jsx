export function SummaryBlock({ text, stats }) {
  return (
    <div className="mx-4 my-2 border border-gray-100 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-white border-b border-gray-100">
        <div className="w-5 h-5 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <span className="text-sm font-medium text-gray-800">总结</span>
      </div>
      <div className="bg-white px-3 pb-3 pt-2">
        <p className="text-sm text-gray-600 leading-relaxed mb-4">{text}</p>
        <div className="grid grid-cols-4 gap-0 border-t border-gray-100 pt-3">
          {stats.map((stat, i) => (
            <div key={i} className="flex flex-col items-center gap-1 px-2">
              <div className="flex items-center gap-1">
                {stat.icon}
                <span className="text-xs text-gray-500">{stat.label}</span>
              </div>
              <span className="text-base font-semibold text-gray-800">{stat.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
