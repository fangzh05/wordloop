import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {describe,it,expect} from "vitest";
import {StandaloneLessonFeedback} from "../web/src/standalone/StandaloneApp.js";

describe("review grading presentation",()=>{
  it.each([true,false])("offers only Continue after grading (correct=%s)",(correct)=>{
    const html=renderToStaticMarkup(<StandaloneLessonFeedback word="sanctuary" progressLabel="正式复习 · 1 / 8" feedback={{is_correct:correct,user_answer:"sanctury",message:"已记录"}} busy={false} busyLabel={null} notice="" nextWord continueOnly nextLabel="继续" onBack={()=>{}} onRetry={()=>{}} onNext={()=>{}}/>);
    expect(html).toContain("继续");
    expect(html).not.toContain("重做");
    expect(html).not.toContain("根据反馈完成本题");
    expect(html).toContain("已记录本次复习结果");
    expect((html.match(/<button/g)??[]).length).toBe(2); // Back and Continue.
  });
});
