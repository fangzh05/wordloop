import { useState } from "react";
import { requestFocusMode } from "../mcpBridge.js";

export function FocusButton(): React.JSX.Element {
  const [message, setMessage] = useState("");

  async function enterFocus(): Promise<void> {
    setMessage("");
    try {
      const success = await requestFocusMode();
      if (!success) setMessage("当前环境不支持专注模式。");
    } catch {
      setMessage("暂时无法进入专注模式。");
    }
  }

  return <span className="focus-control">
    <button className="focus-button" type="button" onClick={() => void enterFocus()}>⛶ 专注</button>
    {message ? <span className="focus-message" role="status">{message}</span> : null}
  </span>;
}
