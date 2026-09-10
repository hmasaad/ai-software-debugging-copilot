import { describe, expect, it } from "vitest";
import { parseErrorText } from "../src/collectors/stack-trace.js";

describe("parseErrorText", () => {
  it("parses a Node stack trace and flags project frames", () => {
    const parsed = parseErrorText(
      `TypeError: Cannot read properties of undefined (reading 'id')
    at getPrimaryItemId (/repo/src/cart.js:16:21)
    at file:///repo/src/crash.js:4:13
    at ModuleJob.run (node:internal/modules/esm/module_job:234:25)`,
      "/repo",
    );

    expect(parsed.language).toBe("javascript");
    expect(parsed.type).toBe("TypeError");
    expect(parsed.message).toContain("undefined");
    expect(parsed.frames[0]).toMatchObject({
      file: "/repo/src/cart.js",
      line: 16,
      column: 21,
      functionName: "getPrimaryItemId",
      inProject: true,
    });
    expect(parsed.frames.some((frame) => frame.file.startsWith("node:"))).toBe(true);
    expect(parsed.frames.find((frame) => frame.file.startsWith("node:"))?.inProject).toBe(false);
  });

  it("parses a Python traceback", () => {
    const parsed = parseErrorText(`Traceback (most recent call last):
  File "app.py", line 10, in <module>
    main()
  File "lib.py", line 4, in main
    raise ValueError("boom")
ValueError: boom`);

    expect(parsed.language).toBe("python");
    expect(parsed.type).toBe("ValueError");
    expect(parsed.message).toBe("boom");
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames[1]).toMatchObject({ file: "lib.py", line: 4, functionName: "main" });
  });

  it("parses a Java stack trace", () => {
    const parsed = parseErrorText(`java.lang.NullPointerException: user
    at com.acme.UserService.load(UserService.java:42)
    at com.acme.UserServiceTest.missingUser(UserServiceTest.java:18)`);

    expect(parsed.language).toBe("java");
    expect(parsed.frames[0]).toMatchObject({
      file: "UserService.java",
      line: 42,
      functionName: "com.acme.UserService.load",
    });
  });

  it("parses a Flutter/Dart stack including a bare file:line", () => {
    const parsed = parseErrorText(`Flutter app crashes when opening Savings screen.

Exception:
Null check operator used on a null value

Stack trace:
#0      SavingsMemberMediaBloc._onLoad (package:app/savings/SavingsMemberMediaBloc.dart:217:12)
#1      Bloc.onEvent (package:bloc/bloc.dart:10:5)
SavingsMemberMediaBloc.dart:217`);

    expect(parsed.language).toBe("dart");
    expect(parsed.type).toBe("NullCheckError");
    expect(parsed.message).toMatch(/Null check operator/);
    expect(parsed.frames[0]).toMatchObject({
      file: "savings/SavingsMemberMediaBloc.dart",
      line: 217,
      column: 12,
      functionName: "SavingsMemberMediaBloc._onLoad",
    });
    expect(parsed.frames.some((frame) => frame.file.endsWith("SavingsMemberMediaBloc.dart") && frame.line === 217)).toBe(
      true,
    );
  });
});
