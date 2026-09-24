# [1.28.0](https://github.com/ProjectAJ14/eklavya/compare/v1.27.1...v1.28.0) (2026-09-24)


### Features

* **dashboard:** draw the memory timeline as a timeline ([d01a500](https://github.com/ProjectAJ14/eklavya/commit/d01a5001fc0195cdd80f1efabf15eafed81b2eb2))

## [1.27.1](https://github.com/ProjectAJ14/eklavya/compare/v1.27.0...v1.27.1) (2026-09-24)


### Bug Fixes

* bring every surface onto the design system ([6ec3203](https://github.com/ProjectAJ14/eklavya/commit/6ec3203060249f87e779a02a8c90c9e596edbaca)), closes [#FF6166](https://github.com/ProjectAJ14/eklavya/issues/FF6166) [#A8201A](https://github.com/ProjectAJ14/eklavya/issues/A8201A) [#E5484D](https://github.com/ProjectAJ14/eklavya/issues/E5484D)

# [1.27.0](https://github.com/ProjectAJ14/eklavya/compare/v1.26.0...v1.27.0) (2026-09-24)


### Bug Fixes

* address review findings on prune, SessionStart and install ([63fa338](https://github.com/ProjectAJ14/eklavya/commit/63fa3380844c2f237b8fa6cb268e07d4419b2db8))
* **artifacts:** review fixes, and stop git maintenance racing test cleanup ([839da85](https://github.com/ProjectAJ14/eklavya/commit/839da85d1faaf02cf9a8abc96300b1f29ac14251))
* **hooks:** close a short prior session at SessionStart ([0c29deb](https://github.com/ProjectAJ14/eklavya/commit/0c29debe8ea3b3d6d5be8ba1f8009107b330cca6))
* **memory:** give each worker generation its own token ([6d5ed27](https://github.com/ProjectAJ14/eklavya/commit/6d5ed27d5d2c7814e7ba375697e2062b18306037))
* **memory:** index event_id on links and candidates ([f5ee5ec](https://github.com/ProjectAJ14/eklavya/commit/f5ee5eca452a99531263901c78ecd6c70ee534df))
* **memory:** scope retention sweeps to one project ([1de1070](https://github.com/ProjectAJ14/eklavya/commit/1de1070baeb0d61e2bdf1a9562f78c3b60a2a2de))
* **runtime:** one install lock; launcher honours auto_update ([dd5dbaa](https://github.com/ProjectAJ14/eklavya/commit/dd5dbaac05675e9d24f4d1e9784338735d3d8600))


### Features

* **artifacts:** Eklavya artifacts, an Artifacts dashboard, and explain_on_wrong ([1304f50](https://github.com/ProjectAJ14/eklavya/commit/1304f5023e95dfab7bb30845340c5c6ddebf3547))

# [1.26.0](https://github.com/ProjectAJ14/eklavya/compare/v1.25.3...v1.26.0) (2026-09-23)


### Features

* **update:** Eklavya updates itself ([dd9f4ef](https://github.com/ProjectAJ14/eklavya/commit/dd9f4efa37100e6ee275a77f901b14328b772729))

## [1.25.3](https://github.com/ProjectAJ14/eklavya/compare/v1.25.2...v1.25.3) (2026-09-23)


### Bug Fixes

* close the gaps a review of the launch-readiness PR found ([f2073eb](https://github.com/ProjectAJ14/eklavya/commit/f2073eb799cc7417fc4d10ca9da8fabdec36a981)), closes [#29](https://github.com/ProjectAJ14/eklavya/issues/29)

## [1.25.2](https://github.com/ProjectAJ14/eklavya/compare/v1.25.1...v1.25.2) (2026-09-23)


### Bug Fixes

* **quiz:** no backlog outside a git repository ([1bc91b3](https://github.com/ProjectAJ14/eklavya/commit/1bc91b3ec87350a59e86f44bb1b99fb36ff20cd6))

## [1.25.1](https://github.com/ProjectAJ14/eklavya/compare/v1.25.0...v1.25.1) (2026-09-23)


### Bug Fixes

* launch-readiness fixes from the pre-launch review ([d2d9db0](https://github.com/ProjectAJ14/eklavya/commit/d2d9db00500e730abf1aeb71a6a3d80c46385bda))

# [1.25.0](https://github.com/ProjectAJ14/eklavya/compare/v1.24.2...v1.25.0) (2026-09-23)


### Features

* **dashboard:** split into Learning and Memory workflows with one project inventory ([1b5509e](https://github.com/ProjectAJ14/eklavya/commit/1b5509e6f1262ce265014726a204d09a369be741))

## [1.24.2](https://github.com/ProjectAJ14/eklavya/compare/v1.24.1...v1.24.2) (2026-09-23)


### Bug Fixes

* **memory:** end the worker's whole tree on every exit, and hold the slot by process identity ([7da5022](https://github.com/ProjectAJ14/eklavya/commit/7da50220b23d4ff38234753a4bf063d968fa2247)), closes [#24](https://github.com/ProjectAJ14/eklavya/issues/24)
* **memory:** no successor after a stop, and no ps under the write lock ([69e6905](https://github.com/ProjectAJ14/eklavya/commit/69e690538fab4e91d2a106e5fdabb7c05e4fd859))

## [1.24.1](https://github.com/ProjectAJ14/eklavya/compare/v1.24.0...v1.24.1) (2026-09-23)


### Bug Fixes

* **memory:** stop the observer spawning workers from its own hooks ([c4a8813](https://github.com/ProjectAJ14/eklavya/commit/c4a8813ae864bac17fbca8f800ad7ba1b7d070e9))

# [1.24.0](https://github.com/ProjectAJ14/eklavya/compare/v1.23.0...v1.24.0) (2026-09-23)


### Bug Fixes

* **memory:** keep the observer on the subscription whatever the shell sets ([a4a83db](https://github.com/ProjectAJ14/eklavya/commit/a4a83db774950bffdee82be8002f4865ecee13fb))
* **memory:** name a missing claude, and start one worker, not one per turn ([02dd67f](https://github.com/ProjectAJ14/eklavya/commit/02dd67fd76892225d749ad22f03e9ceab22dc7ee))
* **memory:** summarise in the background when a model is configured ([1c3dc56](https://github.com/ProjectAJ14/eklavya/commit/1c3dc5661935fc5842528d5a4cc108dcfa5ae2c4))


### Features

* **memory:** pick the memory model at install, run it on the subscription ([b13535a](https://github.com/ProjectAJ14/eklavya/commit/b13535a4a5167327ab9b8514e953e7114136f5cf))

# [1.23.0](https://github.com/ProjectAJ14/eklavya/compare/v1.22.0...v1.23.0) (2026-09-22)


### Bug Fixes

* **import:** give each source its own default snapshot ([785d04d](https://github.com/ProjectAJ14/eklavya/commit/785d04d9fe1a721241513dbf67069820340d77c8))


### Features

* **install:** arrow-key walk, spinners, and a Claude Mem import that finishes ([253320b](https://github.com/ProjectAJ14/eklavya/commit/253320b7f290192f90305a44b61fc7dac48f9ba4))

# [1.22.0](https://github.com/ProjectAJ14/eklavya/compare/v1.21.1...v1.22.0) (2026-09-22)


### Features

* **install:** walk the dials on every install ([60f6f1d](https://github.com/ProjectAJ14/eklavya/commit/60f6f1d593c4685b37bad979079202221d0570eb))

## [1.21.1](https://github.com/ProjectAJ14/eklavya/compare/v1.21.0...v1.21.1) (2026-09-22)


### Bug Fixes

* **quiz:** keep asking while the agent works, and reach the backlog ([2661c32](https://github.com/ProjectAJ14/eklavya/commit/2661c329f56ec653ad57e7be6091843e21df0c3c))

# [1.21.0](https://github.com/ProjectAJ14/eklavya/compare/v1.20.1...v1.21.0) (2026-09-22)


### Features

* **install:** pick one memory recorder when Claude Mem is present ([f994419](https://github.com/ProjectAJ14/eklavya/commit/f994419637eae91efc1aaf49a0027e31413268fb))

## [1.20.1](https://github.com/ProjectAJ14/eklavya/compare/v1.20.0...v1.20.1) (2026-09-22)


### Bug Fixes

* **quiz:** scope session quiz to the current project ([d7eef28](https://github.com/ProjectAJ14/eklavya/commit/d7eef285573d44343b8ef5015d296bf11c990f20))

# [1.20.0](https://github.com/ProjectAJ14/eklavya/compare/v1.19.2...v1.20.0) (2026-09-22)


### Features

* **hooks:** glanceable session-start banner ([b3599f7](https://github.com/ProjectAJ14/eklavya/commit/b3599f7afc64096ad3d4a0e4be4a6a2d33db1ee3))

## [1.19.2](https://github.com/ProjectAJ14/eklavya/compare/v1.19.1...v1.19.2) (2026-09-22)


### Bug Fixes

* **hooks:** show the developer what is written for them ([306f3fc](https://github.com/ProjectAJ14/eklavya/commit/306f3fc0ea055f20d87e6df79ef912dfff326d2a))

## [1.19.1](https://github.com/ProjectAJ14/eklavya/compare/v1.19.0...v1.19.1) (2026-09-22)


### Bug Fixes

* close the review's five gaps in project-scoped config ([7f58255](https://github.com/ProjectAJ14/eklavya/commit/7f58255fe328e0a4ed332838c332ac2eb4e5c5b5))
* keep the trust boundary on the one path that still reads a checkout ([7f5919c](https://github.com/ProjectAJ14/eklavya/commit/7f5919c11654cb509ba73cd3a98f786536210aed))
* **test:** stop the unwritable-home test hanging CI on Linux ([72a6b05](https://github.com/ProjectAJ14/eklavya/commit/72a6b050671ec195f1f84384ff7f24ba517349cd))

# [1.19.0](https://github.com/ProjectAJ14/eklavya/compare/v1.18.3...v1.19.0) (2026-09-22)


### Bug Fixes

* **cli:** three defects in the memory argument layer, found by testing it ([7d2e045](https://github.com/ProjectAJ14/eklavya/commit/7d2e045b903abf89c041609c0be27bccf209d6da))
* **config:** a cloned repository must not be able to run a command ([6607635](https://github.com/ProjectAJ14/eklavya/commit/6607635fbe9d6efae507d06f4168d92ff0d5ed8d))
* **dashboard:** refuse a request that was not addressed to loopback by name ([ec41158](https://github.com/ProjectAJ14/eklavya/commit/ec41158b8a3493f65ad8679037fad5ae9460bb5c))
* **memory:** count a worktree's work against the checkout it branched from ([0172268](https://github.com/ProjectAJ14/eklavya/commit/0172268af2f5a03db87adb075920af31345b9adc))
* **memory:** give a paused queue a way back, and stop retrying without a pause ([8366aa3](https://github.com/ProjectAJ14/eklavya/commit/8366aa3ff480ca7ff6a5b1d5aa704d6be9c2cd74))
* **memory:** let an import file its history under a local checkout ([ff8786c](https://github.com/ProjectAJ14/eklavya/commit/ff8786c6bbb6740baf77e3cce5b8009b13e6c6a1))
* **memory:** link imported evidence to the entry it belongs to ([bbbcefc](https://github.com/ProjectAJ14/eklavya/commit/bbbcefcf246792a3f838dccc9050f4d5ed9b90f9))
* **memory:** retry a notification the sink refused, without sending it twice ([5821877](https://github.com/ProjectAJ14/eklavya/commit/582187763e4e0d2711ad50acc015634ca2dcf533))
* **tools:** register the three tools that were written and never wired up ([7652333](https://github.com/ProjectAJ14/eklavya/commit/7652333a041ae5a4dfa872f6ec6de6d47ee6a0c1))


### Features

* **cli:** say which repo settings were ignored, rather than ignoring them quietly ([4ffdccd](https://github.com/ProjectAJ14/eklavya/commit/4ffdccd7956209265d98d1817086d31553586cea))
* **config:** make the namespaced settings reachable ([25e1be7](https://github.com/ProjectAJ14/eklavya/commit/25e1be756fc329f8d691fdfa39722b7f13ef6689))
* **dashboard:** give the dashboard its memory half ([db41b49](https://github.com/ProjectAJ14/eklavya/commit/db41b49a778376a4c0714fd4b561a9cec20ef725))
* **dashboard:** notice when the page has gone stale, rather than lying quietly ([571b59f](https://github.com/ProjectAJ14/eklavya/commit/571b59fd21f87c7558437fbdb033d77df49b128e))
* **hooks:** capture evidence and recall it at the session seams ([7bb50a6](https://github.com/ProjectAJ14/eklavya/commit/7bb50a6e49392140170fb815a017a5e075c0305d))
* **hooks:** replace the session greeting with the compact startup display ([fd28c68](https://github.com/ProjectAJ14/eklavya/commit/fd28c68ff8899ebade0a341367c5a69e29071a1f))
* **install:** put the dials in the status bar, into an empty slot only ([067a570](https://github.com/ProjectAJ14/eklavya/commit/067a5705e22ba6b26dead70c043cd4e6848b0b6a))
* **learning:** derive concept candidates from evidence, for sessions that logged none ([764fd4a](https://github.com/ProjectAJ14/eklavya/commit/764fd4a74c07b7c08fe88aaee5edb5489ce9b9ac))
* **memory:** add the evidence schema, store and retrieval core ([46f54c3](https://github.com/ProjectAJ14/eklavya/commit/46f54c3272a40f9525a329ced727e3b17f31c5e7))
* **memory:** capture pipeline, observation jobs, recall and startup display ([6dbf92f](https://github.com/ProjectAJ14/eklavya/commit/6dbf92f472bc1102885324c90a5c85ef454927b4))
* **memory:** configured wrap-ups and the one alert worth interrupting for ([a5b3fbf](https://github.com/ProjectAJ14/eklavya/commit/a5b3fbf48daef9158abd22391ff91c421e38b821))
* **memory:** import from Claude Mem, and drive memory from the CLI ([e8d82ee](https://github.com/ProjectAJ14/eklavya/commit/e8d82ee9b69c3da7d12c9dff399e45cbb43c3e50))
* **memory:** multi-device sync through a shared directory ([25d08bf](https://github.com/ProjectAJ14/eklavya/commit/25d08bf886b5877a4753263edfe65a2e9c15d15a)), closes [hi#water](https://github.com/hi/issues/water)
* **memory:** raw evidence on demand, memory in doctor, and a restore ([33ecfcc](https://github.com/ProjectAJ14/eklavya/commit/33ecfccf33c44ce8256afec33c85215b858c153e))
* **memory:** recall against the prompt, not only at the session seam ([8cf1bdd](https://github.com/ProjectAJ14/eklavya/commit/8cf1bdd5d338530f228570d3d0139bd4f0b1b713))
* **memory:** replay transcripts, and record what each host can actually deliver ([5b0e1ff](https://github.com/ProjectAJ14/eklavya/commit/5b0e1ffa69ee5c3d80bc5616ab3d321f919d0fae))
* **memory:** structured code exploration and saved collections ([c020b04](https://github.com/ProjectAJ14/eklavya/commit/c020b04e03d8d41fa78a15e5503f79fbfdc9e6ff))
* **memory:** write a session summary at the seam, and record what produced it ([2bd7054](https://github.com/ProjectAJ14/eklavya/commit/2bd70541d4f066534852ddcdcce7c5f4449ef6dc))
* **skills:** add /eklavya:memory and teach the user skill both halves ([eb95d7b](https://github.com/ProjectAJ14/eklavya/commit/eb95d7b4bfbf62de16fe71823935f799f7f02873))
* **tutor:** let the tutor ground a question in what the project remembers ([e621abf](https://github.com/ProjectAJ14/eklavya/commit/e621abff838f52cdac71e340f014694c45cf706f))


### Performance Improvements

* **memory:** index the key the worker retires a batch by ([26aec54](https://github.com/ProjectAJ14/eklavya/commit/26aec544ce60a90b5f64a94d9d572167f26642ca))
* **memory:** stop searching four times for one prompt ([66c4fb8](https://github.com/ProjectAJ14/eklavya/commit/66c4fb8c57784cdc0b2f4172b2709009075be8e1))

## [1.18.3](https://github.com/ProjectAJ14/eklavya/compare/v1.18.2...v1.18.3) (2026-09-21)


### Bug Fixes

* **hooks:** stop the Stop sweep rendering as a hook error ([d45b223](https://github.com/ProjectAJ14/eklavya/commit/d45b223db84f4f7dfe7c97cf447c4d25d12a3891))

## [1.18.2](https://github.com/ProjectAJ14/eklavya/compare/v1.18.1...v1.18.2) (2026-09-21)


### Bug Fixes

* **session:** key the session pointer by checkout, not globally ([0f085b1](https://github.com/ProjectAJ14/eklavya/commit/0f085b1de9d0cf573a433f6316d7e00d092f780e))

## [1.18.1](https://github.com/ProjectAJ14/eklavya/compare/v1.18.0...v1.18.1) (2026-09-20)


### Bug Fixes

* **hooks:** spend the question budget the interleaved cadence promises ([755a5f1](https://github.com/ProjectAJ14/eklavya/commit/755a5f16e62138f1c4cced97540464951e9f753d))
* **quiz:** sync the plan's cooldown to the cadence's clock, and keep the backlog out of the gate's way ([5e1c9a2](https://github.com/ProjectAJ14/eklavya/commit/5e1c9a245290929fefefdc67bc8271267156ba7e))
* **test:** measure the gate's cost above node startup, not on the wall clock ([4a23310](https://github.com/ProjectAJ14/eklavya/commit/4a23310ec55cdd6b2102cff896246b94792269c9))

# [1.18.0](https://github.com/ProjectAJ14/eklavya/compare/v1.17.1...v1.18.0) (2026-09-20)


### Bug Fixes

* **config:** key the session switch on the right session, and keep the bar honest ([28e849f](https://github.com/ProjectAJ14/eklavya/commit/28e849fa5dff0af9c7b52a3d97ab9cdc951028ac))


### Features

* **config:** turn Eklavya off for one session ([7e15955](https://github.com/ProjectAJ14/eklavya/commit/7e1595545ebe4767772d50e2123fdb1e9970329f))

## [1.17.1](https://github.com/ProjectAJ14/eklavya/compare/v1.17.0...v1.17.1) (2026-09-20)


### Bug Fixes

* **dashboard:** fold the gate-side repo, and merge levels by the furthest band ([005ba7c](https://github.com/ProjectAJ14/eklavya/commit/005ba7ce23430417b4802170274fad2147080d75))
* sign questions in Claude Desktop, where the header chip is never painted ([9d4a5de](https://github.com/ProjectAJ14/eklavya/commit/9d4a5de6b4c852f3784811ad1914e7bff83dd127))
* **store:** treat a git worktree as the project it branched from ([3ce81f4](https://github.com/ProjectAJ14/eklavya/commit/3ce81f4255d981c13cbf6b2273602ea2564fa847))

# [1.17.0](https://github.com/ProjectAJ14/eklavya/compare/v1.16.0...v1.17.0) (2026-09-20)


### Features

* support Claude Desktop — the Code tab and Cowork ([2381f76](https://github.com/ProjectAJ14/eklavya/commit/2381f7601eb48d9eb210464b58a8d6be4470fc1c))

# [1.16.0](https://github.com/ProjectAJ14/eklavya/compare/v1.15.0...v1.16.0) (2026-09-06)


### Features

* concept packs, so the graph can come from outside this repo ([2bc4a5f](https://github.com/ProjectAJ14/eklavya/commit/2bc4a5fb57d28865d4668201860cf79a451d31ac))
* log delegated work with a SubagentStart hook ([c323fc2](https://github.com/ProjectAJ14/eklavya/commit/c323fc223d9869857bc8da34d2a84a66d41b5187))

# [1.15.0](https://github.com/ProjectAJ14/eklavya/compare/v1.14.0...v1.15.0) (2026-09-06)


### Bug Fixes

* **eval:** correct the published history, including both headline numbers ([6c447dc](https://github.com/ProjectAJ14/eklavya/commit/6c447dc05183e9627727772865cba91bbb70b517))
* **eval:** the harness could hang, self-compare, and flatter itself ([614f52e](https://github.com/ProjectAJ14/eklavya/commit/614f52ea72debb6f611e9f1196b72ec7a321eaeb))
* **hooks:** a hook can no longer wait forever on stdin ([0c0e297](https://github.com/ProjectAJ14/eklavya/commit/0c0e297569c79a5f36c9ccd81452af8a5c3147e1)), closes [#443](https://github.com/ProjectAJ14/eklavya/issues/443)
* **hooks:** cap the nudge, re-arm it on resume, and fix the docs it left stale ([68e9543](https://github.com/ProjectAJ14/eklavya/commit/68e9543cdc5c963fe6dc2500ea3f90621ac558d9))
* **hooks:** let go of stdin, or the read resolves and the process never exits ([fe6797c](https://github.com/ProjectAJ14/eklavya/commit/fe6797ca7f9d5f2a76044be5d77ae33cfc1d31bd))
* pre-PR review findings ([ca940a1](https://github.com/ProjectAJ14/eklavya/commit/ca940a1124ac1f06950bc549de13aa8aa2b8520d))
* the three bugs the eval and the reviews turned up ([876bbf0](https://github.com/ProjectAJ14/eklavya/commit/876bbf0922deac26061c614b292d2051ff326ee5))


### Features

* **eval:** measure concept extraction, the step before any question exists ([9dfbc7a](https://github.com/ProjectAJ14/eklavya/commit/9dfbc7a268b0b75ac017983f0e21888567442f0e))
* **eval:** measure the promise on a real history, and publish what it says ([751d973](https://github.com/ProjectAJ14/eklavya/commit/751d973aae1c98480ae7bd78757dcdfcc831cd38))
* **eval:** measure the questions, not just the machinery ([8e5af7e](https://github.com/ProjectAJ14/eklavya/commit/8e5af7eef0dfaf213bb4cff539687466780c96d0))
* **hooks:** restate the log directive on a prompt when a session has logged nothing ([94ec8cf](https://github.com/ProjectAJ14/eklavya/commit/94ec8cf091bc011237c40e91c2a95a9850e3a218))

# [1.14.0](https://github.com/ProjectAJ14/eklavya/compare/v1.13.1...v1.14.0) (2026-09-06)


### Features

* **statusline:** move the dials out of every question and into the status bar ([001ea72](https://github.com/ProjectAJ14/eklavya/commit/001ea72d8eea713b1d79fabd6a722282aa98acf4))

## [1.13.1](https://github.com/ProjectAJ14/eklavya/compare/v1.13.0...v1.13.1) (2026-09-06)


### Bug Fixes

* **tutor:** make the skill description a trigger, not a workflow summary ([b1bf3a2](https://github.com/ProjectAJ14/eklavya/commit/b1bf3a278563748b22abb2184e6a732c5d20adf9))

# [1.13.0](https://github.com/ProjectAJ14/eklavya/compare/v1.12.0...v1.13.0) (2026-09-06)


### Features

* **doctor:** check the install and name the repair when it has broken ([e36fff6](https://github.com/ProjectAJ14/eklavya/commit/e36fff61d0971582714eb694b7f6f60a80bf68b2))

# [1.12.0](https://github.com/ProjectAJ14/eklavya/compare/v1.11.1...v1.12.0) (2026-09-06)


### Features

* **install:** pull the marketplace checkout forward instead of leaving it stale ([d07caf6](https://github.com/ProjectAJ14/eklavya/commit/d07caf64307061982777732d96277c02fc09e1ed))

## [1.11.1](https://github.com/ProjectAJ14/eklavya/compare/v1.11.0...v1.11.1) (2026-09-06)


### Bug Fixes

* correct what the plugin tells the model, and let the gate say what remains ([321542a](https://github.com/ProjectAJ14/eklavya/commit/321542a94ce2a56676c3c3520f3e0d93217e957c))

# [1.11.0](https://github.com/ProjectAJ14/eklavya/compare/v1.10.0...v1.11.0) (2026-09-06)


### Features

* **dashboard:** open it in the browser instead of printing a URL ([71593e7](https://github.com/ProjectAJ14/eklavya/commit/71593e79a782cda746275aab545e562b87fc1b64))

# [1.10.0](https://github.com/ProjectAJ14/eklavya/compare/v1.9.4...v1.10.0) (2026-09-06)


### Features

* **ask:** label every dial in the settings line ([2bdd5fa](https://github.com/ProjectAJ14/eklavya/commit/2bdd5faceba7adda4165f6e9169755a1650968e7))
* **dashboard:** rebuild it as a navigable learning record ([d00936c](https://github.com/ProjectAJ14/eklavya/commit/d00936ccd5e75d280ea052b86038116b1261feac))

## [1.9.4](https://github.com/ProjectAJ14/eklavya/compare/v1.9.3...v1.9.4) (2026-09-06)


### Bug Fixes

* clear every contrast failure on paper, and two left on ink ([eb7181a](https://github.com/ProjectAJ14/eklavya/commit/eb7181ad932c0b80025a87fbea4013a525e08b06))

## [1.9.3](https://github.com/ProjectAJ14/eklavya/compare/v1.9.2...v1.9.3) (2026-09-06)


### Bug Fixes

* restyle the dashboard onto the site's design system ([4577890](https://github.com/ProjectAJ14/eklavya/commit/4577890d00fd13cdb1c0a4b031146084a78b629e))

## [1.9.2](https://github.com/ProjectAJ14/eklavya/compare/v1.9.1...v1.9.2) (2026-09-06)


### Bug Fixes

* stop promising an eklavya command that is not on PATH ([f765097](https://github.com/ProjectAJ14/eklavya/commit/f7650978d8252d65970e92c58f430e3e4dd315f2))

## [1.9.1](https://github.com/ProjectAJ14/eklavya/compare/v1.9.0...v1.9.1) (2026-09-05)


### Bug Fixes

* ask one question at a time on the interleaved cadence ([be64c5c](https://github.com/ProjectAJ14/eklavya/commit/be64c5c91c346f37a9c79e533de6d6986da4d309))

# [1.9.0](https://github.com/ProjectAJ14/eklavya/compare/v1.8.1...v1.9.0) (2026-09-05)


### Features

* control Eklavya from plain chat with a user-level skill ([9ea100e](https://github.com/ProjectAJ14/eklavya/commit/9ea100e7ab49359c84a944bef9b1b758fbef59ce))
* print the settings line above the question, in brackets ([9cf406c](https://github.com/ProjectAJ14/eklavya/commit/9cf406c3fc1f2d6eedba38e0a3b0150b182733f4))

## [1.8.1](https://github.com/ProjectAJ14/eklavya/compare/v1.8.0...v1.8.1) (2026-09-05)


### Bug Fixes

* the plugin's MCP server could not start when installed from the marketplace ([8e7f862](https://github.com/ProjectAJ14/eklavya/commit/8e7f86247afd6ef51d5c1b3d68842822764faf4b))

# [1.8.0](https://github.com/ProjectAJ14/eklavya/compare/v1.7.0...v1.8.0) (2026-09-05)


### Bug Fixes

* stop the installer destroying existing installs ([cc3d072](https://github.com/ProjectAJ14/eklavya/commit/cc3d072f59b32648a1b2fcbbfff0b306d9f3f6ed))


### Features

* install with one command on macOS and Windows ([afbcbb3](https://github.com/ProjectAJ14/eklavya/commit/afbcbb382a6836229c67406ade697f466c88b03c)), closes [claude-code#18610](https://github.com/claude-code/issues/18610) [#21847](https://github.com/ProjectAJ14/eklavya/issues/21847) [#23556](https://github.com/ProjectAJ14/eklavya/issues/23556) [#73971](https://github.com/ProjectAJ14/eklavya/issues/73971)

# [1.7.0](https://github.com/ProjectAJ14/eklavya/compare/v1.6.1...v1.7.0) (2026-08-29)


### Features

* **dashboard:** serve the learning history on localhost ([33cddac](https://github.com/ProjectAJ14/eklavya/commit/33cddac491a5f3f5c76be58df898b3d78bd21154))
* **progress:** report which project, what it taught, what was skipped ([fe9469e](https://github.com/ProjectAJ14/eklavya/commit/fe9469e4677c097317a5df1dbdb7c4f55ba7f8db))
* say which settings asked the question, and make sure it shows ([055e791](https://github.com/ProjectAJ14/eklavya/commit/055e791661b2a86b80d94d7feaf12e9038617e3e))

## [1.6.1](https://github.com/ProjectAJ14/eklavya/compare/v1.6.0...v1.6.1) (2026-08-27)


### Bug Fixes

* start the MCP server when no plugin loader expanded the root ([83612cb](https://github.com/ProjectAJ14/eklavya/commit/83612cb07ec2f6baf9e7210d29c0e1cc08189351))

# [1.6.0](https://github.com/ProjectAJ14/eklavya/compare/v1.5.0...v1.6.0) (2026-08-27)


### Features

* **site:** sharpen the page's motion and rhythm ([b0aa30e](https://github.com/ProjectAJ14/eklavya/commit/b0aa30e1f3fb8f0e8e0f2f40075a664974b585ef))

# [1.5.0](https://github.com/ProjectAJ14/eklavya/compare/v1.4.1...v1.5.0) (2026-08-27)


### Features

* **quiz:** earn a difficulty level per project, easy to hard ([c83c3f6](https://github.com/ProjectAJ14/eklavya/commit/c83c3f67a316acdd4adb1141c0f0542990841938))

## [1.4.1](https://github.com/ProjectAJ14/eklavya/compare/v1.4.0...v1.4.1) (2026-08-27)


### Bug Fixes

* **quiz:** put Eklavya's name on the question it is asking ([80ada06](https://github.com/ProjectAJ14/eklavya/commit/80ada06114ceaaceb30a8c5c2e2efde7d25c79c3))

# [1.4.0](https://github.com/ProjectAJ14/eklavya/compare/v1.3.0...v1.4.0) (2026-08-27)


### Features

* ask the questions while the agent is still working ([1e9f106](https://github.com/ProjectAJ14/eklavya/commit/1e9f1061a5fcff640f221ddf553cf3ba3b100dda))

# [1.3.0](https://github.com/ProjectAJ14/eklavya/compare/v1.2.0...v1.3.0) (2026-08-27)


### Features

* stop the correct answer always landing first, and ask it plainly ([a50dcc8](https://github.com/ProjectAJ14/eklavya/commit/a50dcc87edef86f4e4997190f5668e13f291cc5c))

# [1.2.0](https://github.com/ProjectAJ14/eklavya/compare/v1.1.0...v1.2.0) (2026-08-26)


### Features

* ask quiz questions as multiple choice ([c05a50f](https://github.com/ProjectAJ14/eklavya/commit/c05a50fab06a4005f3cf90298fec787124aa9c62))

# [1.1.0](https://github.com/ProjectAJ14/eklavya/compare/v1.0.1...v1.1.0) (2026-08-26)


### Bug Fixes

* keep the enforced gate reachable when every answer is a blank ([d0aaf1a](https://github.com/ProjectAJ14/eklavya/commit/d0aaf1a0aa5cf752628eb1a92fdb2e6c3e05bba4))
* teach the blanks instead of recording them as skips ([8174a9d](https://github.com/ProjectAJ14/eklavya/commit/8174a9d852c27bd229ed5556d65a4f13540f5f7e))


### Features

* add focus, the dial for what Eklavya teaches ([d3e1c2a](https://github.com/ProjectAJ14/eklavya/commit/d3e1c2a29068b7703d9e50c8fd7c4dfb583167c5))

## [1.0.1](https://github.com/ProjectAJ14/eklavya/compare/v1.0.0...v1.0.1) (2026-08-26)


### Bug Fixes

* connect the MCP server on a fresh plugin install [skip ci] ([24b038f](https://github.com/ProjectAJ14/eklavya/commit/24b038f1048d445f8a4ba1b2ab3fad62f5190b81))
* make "never ask the same question twice" actually enforced ([de1d0fa](https://github.com/ProjectAJ14/eklavya/commit/de1d0fa5593c68d1e22d6d5a4213f48af8af1923))
* report the real server version over MCP ([4eca0e1](https://github.com/ProjectAJ14/eklavya/commit/4eca0e15e459a2da941b2538bf52e12ebac19720))
* state the concept-logging instruction where every session sees it ([bac75dc](https://github.com/ProjectAJ14/eklavya/commit/bac75dc12c74c1b8316f296cb2f51898d3388667))

# Changelog

<!-- Entries below this line are generated by semantic-release from Conventional
     Commits. The 1.0.0 entry is hand-written because that release was published
     manually while CI authentication was still being sorted out. -->

## 1.0.0 (2026-08-26)

First release. Eklavya turns coding-agent generation time into learning time: while Claude Code implements a task, it teaches the developer the concepts behind that exact work, tracks mastery locally, and can hold commits until the developer demonstrates understanding.

### Features

* **phase-0:** scaffold plugin, MCP server, schema and seed graphs — 87 concepts and 88 prerequisite edges across `web-auth`, `react`, `node-backend` and `git`
* **phase-1:** the teaching loop end to end — nine MCP tools, SM-2 scheduling with read-time decay, the tutor skill, and five `/eklavya:*` commands
* **phase-2:** automatic ambient loop — `SessionStart` profile injection and a `Stop` hook that quizzes once per batch of logged work
* **phase-3:** the commit gate, enforced inside Claude Code and from a bare terminal via a git `pre-commit` hook
* **phase-4:** parallel tutoring — a read-only `eklavya-tutor` subagent and a two-pane shared-database workflow
* **phase-5:** packaging, marketplace manifest, and the `eklavya` CLI including `export-rules` for Cursor

### Bug Fixes

* the plugin is usable when installed from git — the server launches through a wrapper that prefers a local build and falls back to the published package
