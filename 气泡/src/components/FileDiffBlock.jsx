export function FileDiffBlock({ time, files }) {
  return (
    <div className="mx-4 my-2 border border-gray-100 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100">
        <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <span className="text-xs font-medium text-gray-700">文件变更</span>
        <span className="text-xs text-gray-400">{files.length} 个文件</span>
        <span className="ml-auto text-xs text-gray-400">{time}</span>
      </div>
      <div className="bg-white divide-y divide-gray-50">
        {files.map((file, i) => (
          <div key={i} className="px-3 py-2">
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              <span className="text-xs text-gray-600 flex-1">{file.path}</span>
              <span className="text-xs text-green-600 font-medium">{file.added}</span>
              <span className="text-xs text-red-500 font-medium">{file.removed}</span>
            </div>
            <div className="rounded overflow-hidden border border-gray-100 text-xs font-mono">
              <div className="grid grid-cols-2 divide-x divide-gray-100">
                <div className="bg-red-50 px-2 py-1.5 space-y-0.5">
                  {file.before.map((line, j) => (
                    <div key={j} className="flex gap-1">
                      <span className="text-gray-400 select-none w-5 text-right flex-shrink-0">{file.beforeStart + j}</span>
                      <span className={`${line.changed ? "text-red-600 bg-red-100 rounded px-0.5" : "text-gray-500"} leading-5 break-all`}>
                        {line.changed && <span className="text-red-400 mr-0.5">-</span>}
                        {line.text}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="bg-green-50 px-2 py-1.5 space-y-0.5">
                  {file.after.map((line, j) => (
                    <div key={j} className="flex gap-1">
                      <span className="text-gray-400 select-none w-5 text-right flex-shrink-0">{file.afterStart + j}</span>
                      <span className={`${line.changed ? "text-green-700 bg-green-100 rounded px-0.5" : "text-gray-500"} leading-5 break-all`}>
                        {line.changed && <span className="text-green-500 mr-0.5">+</span>}
                        {line.text}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
