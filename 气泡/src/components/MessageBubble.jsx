export function MessageBubble({ text, time }) {
  return (
    <div className="flex items-start gap-2 px-4 py-3">
      <div className="mt-0.5 w-4 h-4 flex-shrink-0">
        <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4 text-blue-400">
          <path d="M8 1l1.5 4.5H14l-3.5 2.5 1.5 4.5L8 10 4 12.5l1.5-4.5L2 5.5h4.5L8 1z" fill="currentColor" />
        </svg>
      </div>
      <div className="flex-1 flex items-start justify-between gap-4">
        <p className="text-sm text-gray-800 leading-relaxed">{text}</p>
        <span className="text-xs text-gray-400 flex-shrink-0 mt-0.5">{time}</span>
      </div>
    </div>
  );
}
