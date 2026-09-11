import type { FailureCategory } from "../types.js";

export type EvalProbe = "classify" | "env" | "production" | "blast" | "memory" | "attempts";

export interface KnownBugGold {
  category: FailureCategory;
  subtype?: string;
  reproduce: boolean;
  expectFix: boolean;
  expectRegressionTest: boolean;
  trap: boolean;
  iterations: number;
  envMismatch?: string[];
  productionAction?: "rollback" | "hotfix" | "investigate";
}

export interface KnownBug {
  id: string;
  title: string;
  error: string;
  stack?: string;
  extra?: string;
  snippet?: { file: string; content: string; expression: string };
  probe: EvalProbe;
  required?: boolean;
  production?: {
    version: string;
    affectedUsers?: number;
    firstSeen?: string;
    introducing?: string;
    source?: "crashlytics" | "sentry" | "logs";
  };
  gold: KnownBugGold;
}

const JS_ID = {
  file: "src/cart.js",
  content: `export function getPrimaryItemId(order) {
  return order.item.id;
}
`,
  expression: "return order.item.id;",
};

const JS_QTY = {
  file: "src/cart.js",
  content: `export function lineTotal(item) {
  return item.price * item.qty;
}
`,
  expression: "return item.price * item.qty;",
};

const DART_ID = {
  file: "lib/savings/savings_repository.dart",
  content: `dynamic load(Order order) {
  return order.item.id;
}
`,
  expression: "return order.item.id;",
};

/**
 * 100 labeled bugs the copilot is scored against: classify, reproduce, patch, and
 * regression-test each one, plus false-positive traps and product probes.
 */
export function buildKnownBugs(): KnownBug[] {
  const bugs: KnownBug[] = [];

  const dartFiles = [
    "lib/savings/savings_bloc.dart",
    "lib/savings/savings_repository.dart",
    "lib/savings/savings_details_bloc.dart",
    "lib/media/savings_member_media_bloc.dart",
    "lib/media/media_screen.dart",
    "lib/reports/reports_bloc.dart",
    "lib/shareout/shareout_bloc.dart",
    "lib/auth/session_cubit.dart",
    "lib/home/home_screen.dart",
    "lib/profile/profile_repository.dart",
    "lib/wallet/wallet_bloc.dart",
    "lib/notifications/push_handler.dart",
    "lib/settings/settings_controller.dart",
    "lib/onboarding/onboarding_bloc.dart",
  ];
  for (const [index, file] of dartFiles.entries()) {
    const bangOperator = index < 7;
    bugs.push(
      classifyBug(`Dart null crash in ${file}`, {
        error: "Null check operator used on a null value",
        stack: dartStack(file, 210 + index, "_onLoad"),
        snippet: bangOperator
          ? {
              file,
              content: `dynamic load() {\n  return response.data!;\n}\n`,
              expression: "return response.data!;",
            }
          : { ...DART_ID, file },
        gold: {
          category: "runtime-crash",
          subtype: "Null Crash",
          reproduce: true,
          expectFix: true,
          expectRegressionTest: true,
          trap: false,
          iterations: 2,
        },
      }),
    );
  }

  const jsFiles = [
    "src/cart.js",
    "src/order.js",
    "src/invoice.js",
    "src/checkout.js",
    "src/wallet.js",
    "src/profile.js",
    "src/catalog.js",
    "src/shipping.js",
    "src/discount.js",
    "src/session.js",
  ];
  for (const [index, file] of jsFiles.entries()) {
    bugs.push(
      classifyBug(`TypeError reading id in ${file}`, {
        error: "TypeError: Cannot read properties of undefined (reading 'id')",
        stack: jsStack(file, 12 + index, "getPrimaryItemId"),
        snippet: { ...JS_ID, file },
        gold: {
          category: "runtime-crash",
          subtype: "Null Crash",
          reproduce: true,
          expectFix: true,
          expectRegressionTest: true,
          trap: false,
          iterations: 2,
        },
      }),
    );
  }

  for (const task of ["assembleDebug", "assembleRelease", "bundleRelease"]) {
    bugs.push(
      classifyBug(`Gradle ${task} failure`, {
        error: `FAILURE: Build failed with an exception. Gradle task ${task}`,
        gold: {
          category: "build-failure",
          subtype: "Gradle",
          reproduce: true,
          expectFix: false,
          expectRegressionTest: false,
          trap: false,
          iterations: 3,
        },
      }),
    );
  }

  bugs.push(
    trap("Green CI is not a crash to patch", {
      error: "User reported a crash. All tests passed in CI.",
      gold: {
        category: "configuration-environment",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: true,
        iterations: 1,
      },
    }),
    trap("Standup crash with no stack", {
      error: "Possible crash while exporting the weekly report",
      gold: {
        category: "logic-error",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: true,
        iterations: 1,
      },
    }),
    trap("Fatal log without a failure", {
      error: "Fatal: job cancelled before tests ran",
      gold: {
        category: "configuration-environment",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: true,
        iterations: 1,
      },
    }),
  );

  for (const spec of ["Firebase/Core", "GoogleMaps", "Flutter", "Sentry"]) {
    bugs.push(
      classifyBug(`CocoaPods ${spec} install failure`, {
        error: `[!] CocoaPods could not find compatible versions for pod "${spec}" (pod install)`,
        gold: {
          category: "build-failure",
          subtype: "CocoaPods",
          reproduce: true,
          expectFix: false,
          expectRegressionTest: false,
          trap: false,
          iterations: 3,
        },
      }),
    );
  }

  for (const scheme of ["Runner", "Staging", "Prod", "Shareout"]) {
    bugs.push(
      classifyBug(`Xcode ${scheme} build failure`, {
        error: `xcodebuild: error: The scheme '${scheme}' does not exist. Xcode build failed.`,
        gold: {
          category: "build-failure",
          subtype: "Xcode",
          reproduce: true,
          expectFix: false,
          expectRegressionTest: false,
          trap: false,
          iterations: 3,
        },
      }),
    );
  }

  const dioErrors = [
    "DioException [connection error]: SocketException: Failed host lookup",
    "DioException [bad response]: status code 500",
    "DioException [connection timeout]: http://api.internal/savings",
    "DioException [cancel]: API request cancelled",
    "SocketException: Connection refused api.internal",
    "DioException: Null check operator used on a null value",
    "DioException [bad response]: Null check operator used on a null value",
    "DioException [connection error]: Null check operator used on a null value",
  ];
  for (const [index, error] of dioErrors.entries()) {
    const nullCrash = /Null check operator/i.test(error);
    bugs.push(
      classifyBug(`Network failure: ${error.slice(0, 42)}`, {
        error,
        stack: dartStack("lib/network/savings_api.dart", 40 + index, "fetchSavings"),
        gold: {
          category: nullCrash ? "runtime-crash" : "api-backend-issue",
          subtype: nullCrash ? "Null Crash" : undefined,
          reproduce: true,
          expectFix: false,
          expectRegressionTest: true,
          trap: false,
          iterations: 2,
        },
      }),
    );
  }

  const driftErrors = [
    "drift constraint failed UNIQUE index savings_members",
    "SqliteException: database is locked",
    "Postgres unique index violation on shareout_id",
    "MySQL constraint failed inserting wallet_row",
    "MongoDB duplicate key on reports_cache",
    "drift database closed while querying SavingsTable",
  ];
  for (const [index, error] of driftErrors.entries()) {
    bugs.push(
      classifyBug(`Database: ${error.slice(0, 40)}`, {
        error,
        stack: dartStack("lib/db/savings_dao.dart", 80 + index, "insertMember"),
        gold: {
          category: "database-issue",
          reproduce: true,
          expectFix: false,
          expectRegressionTest: true,
          trap: false,
          iterations: 2,
        },
      }),
    );
  }

  const blocErrors = [
    "Cubit emit() wrong state in SavingsBloc",
    "Bloc did not emit expected Loaded state",
    "Riverpod provider threw wrong state",
    "setState() called after dispose on MediaScreen",
    "ProviderNotFoundException wrong state",
    "SavingsBloc closed before emit()",
    "Cubit skipped Loaded and stayed Empty",
  ];
  for (const [index, error] of blocErrors.entries()) {
    bugs.push(
      classifyBug(error, {
        error,
        stack: dartStack("lib/savings/savings_bloc.dart", 90 + index, "onLoad"),
        gold: {
          category: "state-management-issue",
          subtype: "Wrong state",
          reproduce: true,
          expectFix: false,
          expectRegressionTest: true,
          trap: false,
          iterations: 2,
        },
      }),
    );
  }

  const uiErrors = [
    "A RenderFlex overflowed by 23 pixels on the right",
    "RenderFlex overflowed by 12 pixels at SavingsScreen",
    "Widget build failed: BuildContext lookup",
    "Scaffold geometry overflowed on Media screen",
    "ui issue: yellow/black stripes on Shareout",
  ];
  for (const [index, error] of uiErrors.entries()) {
    bugs.push(
      classifyBug(error, {
        error,
        stack: dartStack("lib/ui/savings_screen.dart", 30 + index, "build"),
        gold: {
          category: "ui-issue",
          reproduce: true,
          expectFix: false,
          expectRegressionTest: true,
          trap: false,
          iterations: 1,
        },
      }),
    );
  }

  const raceErrors = [
    "Concurrent modification during isolate iteration (race)",
    "Deadlock waiting on mutex in ShareoutIsolate",
    "Unhandled race during concurrent modification on isolate",
    "Thread race on savings cache isolate",
  ];
  for (const [index, error] of raceErrors.entries()) {
    bugs.push(
      classifyBug(error, {
        error,
        stack: dartStack("lib/shareout/shareout_isolate.dart", 50 + index, "compute"),
        gold: {
          category: "concurrency-race",
          subtype: "Race condition",
          reproduce: true,
          expectFix: false,
          expectRegressionTest: true,
          trap: false,
          iterations: 3,
        },
      }),
    );
  }

  for (const error of [
    "ANR Input dispatching timed out",
    "Application not responding (ANR) on Reports screen",
    "ANR in SavingsBloc after launch",
  ]) {
    bugs.push(
      classifyBug(error, {
        error,
        gold: {
          category: "performance-issue",
          subtype: "ANR",
          reproduce: true,
          expectFix: false,
          expectRegressionTest: false,
          trap: false,
          iterations: 3,
        },
      }),
    );
  }

  const calcFiles = ["src/cart.js", "src/tax.js", "src/discount.js", "src/shareout.js", "src/fx.js"];
  for (const [index, file] of calcFiles.entries()) {
    bugs.push(
      classifyBug(`Wrong calculation in ${file}`, {
        error: "AssertionError: Expected 10 to equal NaN (wrong calculation)",
        stack: jsStack(file, 8 + index, "lineTotal"),
        snippet: { ...JS_QTY, file },
        gold: {
          category: "logic-error",
          subtype: "Wrong calculation",
          reproduce: true,
          expectFix: true,
          expectRegressionTest: true,
          trap: false,
          iterations: 2,
        },
      }),
    );
  }

  for (const mod of ["lodash", "dio", "firebase_core", "sentry"]) {
    bugs.push(
      classifyBug(`Missing module ${mod}`, {
        error: `Error: Cannot find module '${mod}'`,
        gold: {
          category: "dependency-issue",
          reproduce: true,
          expectFix: false,
          expectRegressionTest: false,
          trap: false,
          iterations: 1,
        },
      }),
    );
  }

  bugs.push(
    classifyBug("Flavor mismatch on Developer B machine", {
      error: "works on my machine flavor staging NODE_ENV=test",
      gold: {
        category: "configuration-environment",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: false,
        iterations: 1,
      },
    }),
    classifyBug("Configuration flavor not applied", {
      error: "APP_FLAVOR staging configuration missing at runtime",
      gold: {
        category: "configuration-environment",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: false,
        iterations: 1,
      },
    }),
  );

  bugs.push(
    classifyBug("MissingPluginException getBattery", {
      error: "MissingPluginException(No implementation found for method getBattery on channel app.battery)",
      stack: dartStack("lib/platform/battery_channel.dart", 12, "getBattery"),
      gold: {
        category: "runtime-crash",
        reproduce: true,
        expectFix: false,
        expectRegressionTest: true,
        trap: false,
        iterations: 2,
      },
    }),
    classifyBug("MissingPluginException share", {
      error: "Unhandled Exception: MissingPluginException(No implementation found for method share)",
      stack: dartStack("lib/platform/share_channel.dart", 9, "share"),
      gold: {
        category: "runtime-crash",
        reproduce: true,
        expectFix: false,
        expectRegressionTest: true,
        trap: false,
        iterations: 2,
      },
    }),
  );

  bugs.push(
    classifyBug("Reported crash did not recur", {
      error: "Null check operator used on a null value",
      stack: dartStack("lib/savings/savings_bloc.dart", 217, "_onLoad"),
      gold: {
        category: "runtime-crash",
        subtype: "Null Crash",
        reproduce: false,
        expectFix: true,
        expectRegressionTest: true,
        trap: false,
        iterations: 1,
      },
      snippet: { ...DART_ID, file: "lib/savings/savings_bloc.dart" },
    }),
  );

  bugs.push(
    trap("Standup mentioned a crash; flavor staging works on my machine", {
      error: "flavor staging works on my machine; did not crash after config change",
      gold: {
        category: "configuration-environment",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: true,
        iterations: 1,
      },
    }),
    trap("XSS report is not a runtime crash", {
      error: "Potential XSS injection in token rendering",
      gold: {
        category: "security-issue",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: true,
        iterations: 1,
      },
    }),
    trap("Frame skips are a performance issue", {
      error: "Skipped 120 frames; possible performance jank on Reports",
      gold: {
        category: "performance-issue",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: true,
        iterations: 1,
      },
    }),
    trap("Lockfile peer dependency is not a crash", {
      error: "npm ERR! peer dep missing: lockfile version mismatch in pubspec.yaml",
      gold: {
        category: "dependency-issue",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: true,
        iterations: 1,
      },
    }),
  );

  bugs.push(
    envBug("Flutter/Xcode mismatch vs Developer B", {
      error: "works on my machine flavor staging",
      extra: "Developer B\nFlutter 3.27\nXcode 15.1",
      gold: {
        category: "configuration-environment",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: false,
        iterations: 1,
        envMismatch: ["flutter", "xcode"],
      },
    }),
    envBug("Flutter-only toolchain mismatch", {
      error: "environment flavor prod works on my machine",
      extra: "Developer B\nFlutter 3.19",
      gold: {
        category: "configuration-environment",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: false,
        iterations: 1,
        envMismatch: ["flutter"],
      },
    }),
    envBug("Xcode-only toolchain mismatch", {
      error: "environment flavor ci works on my machine",
      extra: "Developer B\nXcode 15.1",
      gold: {
        category: "configuration-environment",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: false,
        iterations: 1,
        envMismatch: ["xcode"],
      },
    }),
    envBug("Flavor configuration without toolchain drift", {
      error: "APP_FLAVOR=staging configuration environment",
      extra: "Developer B\nFlutter 3.44\nXcode 16.2",
      gold: {
        category: "configuration-environment",
        reproduce: false,
        expectFix: false,
        expectRegressionTest: false,
        trap: false,
        iterations: 1,
        envMismatch: [],
      },
    }),
  );

  bugs.push(
    productionBug("Crashlytics SEV-1 Firebase init", {
      error: "Null check operator used on a null value",
      stack: dartStack("lib/startup/boot.dart", 18, "initialize"),
      gold: {
        category: "runtime-crash",
        subtype: "Null Crash",
        reproduce: true,
        expectFix: false,
        expectRegressionTest: true,
        trap: false,
        iterations: 1,
        productionAction: "rollback",
      },
      required: true,
      production: {
        version: "1.0.181",
        affectedUsers: 327,
        firstSeen: "14:32 UTC",
        introducing: "Firebase initialization change",
        source: "crashlytics",
      },
    }),
    productionBug("Sentry hotfix-sized crash", {
      error: "Null check operator used on a null value",
      stack: dartStack("lib/auth/session_cubit.dart", 44, "restore"),
      gold: {
        category: "runtime-crash",
        subtype: "Null Crash",
        reproduce: true,
        expectFix: false,
        expectRegressionTest: true,
        trap: false,
        iterations: 1,
        productionAction: "hotfix",
      },
      production: {
        version: "2.4.0",
        affectedUsers: 12,
        firstSeen: "09:01 UTC",
        introducing: "Tighten session restore",
        source: "sentry",
      },
    }),
    productionBug("Log-only investigate", {
      error: "Null check operator used on a null value",
      gold: {
        category: "runtime-crash",
        subtype: "Null Crash",
        reproduce: true,
        expectFix: false,
        expectRegressionTest: false,
        trap: false,
        iterations: 1,
        productionAction: "investigate",
      },
      production: {
        version: "1.2.0",
        firstSeen: "11:00 UTC",
        source: "logs",
      },
    }),
    productionBug("Crashlytics rollback at 100 users", {
      error: "TypeError: Cannot read properties of null (reading 'id')",
      stack: jsStack("src/cart.js", 12, "getPrimaryItemId"),
      snippet: JS_ID,
      gold: {
        category: "runtime-crash",
        subtype: "Null Crash",
        reproduce: true,
        expectFix: true,
        expectRegressionTest: true,
        trap: false,
        iterations: 1,
        productionAction: "rollback",
      },
      production: {
        version: "3.0.0",
        affectedUsers: 100,
        firstSeen: "01:00 UTC",
        introducing: "Cart primary item lookup",
        source: "crashlytics",
      },
    }),
  );

  bugs.push({
    id: "",
    title: "Blast radius of SavingsRepository",
    error: "Null check operator used on a null value",
    stack: dartStack("lib/savings/savings_repository.dart", 88, "getSavingsMedia"),
    probe: "blast",
    required: true,
    gold: {
      category: "runtime-crash",
      subtype: "Null Crash",
      reproduce: true,
      expectFix: false,
      expectRegressionTest: true,
      trap: false,
      iterations: 1,
    },
  });

  bugs.push({
    id: "",
    title: "Recall similar historical incidents",
    error: "Null check operator used on a null value",
    stack: dartStack("lib/media/savings_member_media_bloc.dart", 217, "_onLoad"),
    probe: "memory",
    required: true,
    gold: {
      category: "runtime-crash",
      subtype: "Null Crash",
      reproduce: true,
      expectFix: false,
      expectRegressionTest: true,
      trap: false,
      iterations: 1,
    },
  });

  bugs.push({
    id: "",
    title: "Patch → test → verify attempt log",
    error: "AssertionError: Expected 10 to equal NaN",
    stack: jsStack("src/cart.js", 4, "lineTotal"),
    snippet: JS_QTY,
    probe: "attempts",
    required: true,
    gold: {
      category: "logic-error",
      subtype: "Wrong calculation",
      reproduce: true,
      expectFix: true,
      expectRegressionTest: true,
      trap: false,
      iterations: 3,
    },
  });

  return numberBugs(bugs);
}

export const KNOWN_BUGS = buildKnownBugs();

if (KNOWN_BUGS.length !== 100) {
  throw new Error(`Expected 100 known bugs, got ${KNOWN_BUGS.length}`);
}

function classifyBug(
  title: string,
  fields: Omit<KnownBug, "id" | "title" | "probe"> & { probe?: EvalProbe },
): KnownBug {
  return { id: "", title, probe: fields.probe ?? "classify", ...fields };
}

function trap(title: string, fields: Omit<KnownBug, "id" | "title" | "probe">): KnownBug {
  return { id: "", title, probe: "classify", ...fields };
}

function envBug(title: string, fields: Omit<KnownBug, "id" | "title" | "probe">): KnownBug {
  return { id: "", title, probe: "env", required: true, ...fields };
}

function productionBug(title: string, fields: Omit<KnownBug, "id" | "title" | "probe">): KnownBug {
  return { id: "", title, probe: "production", ...fields };
}

function numberBugs(bugs: KnownBug[]): KnownBug[] {
  return bugs.map((bug, index) => ({
    ...bug,
    id: `bug-${String(index + 1).padStart(3, "0")}`,
  }));
}

function dartStack(file: string, line: number, fn: string): string {
  return `#0      ${fn} (package:app/${file}:${line}:12)\n#1      _rootRun (dart:async/zone.dart:1:1)`;
}

function jsStack(file: string, line: number, fn: string): string {
  return `    at ${fn} (${file}:${line}:18)`;
}
