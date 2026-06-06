const stepColors = ["text-purple-600", "text-orange-500", "text-green-600", "text-blue-500", "text-red-500"];
const stepBgs = ["bg-purple-50", "bg-orange-50", "bg-green-50", "bg-blue-50", "bg-red-50"];

export function PlanBlock({ time, steps }) {
  return (
    <div className="mx-4 my-2 border border-gray-100 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100">
        <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
        <span className="text-xs font-medium text-gray-700">生成计划</span>
        <span className="text-xs text-gray-400">{steps.length} 步</span>
        <span className="ml-auto text-xs text-gray-400">{time}</span>
      </div>
      <div className="bg-white px-3 py-2 space-y-0">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-3 py-2.5 border-b border-gray-50 last:border-0">
            <div className={`w-5 h-5 rounded flex items-center justify-center flex-shrink-0 text-xs font-bold ${stepColors[i % stepColors.length]} ${stepBgs[i % stepBgs.length]}`}>
              {i + 1}
            </div>
            <span className="text-sm text-gray-700 flex-1">{step}</span>
            <svg className="w-4 h-4 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        ))}
      </div>
    </div>
  );
}
