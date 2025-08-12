flowchart TD
    Start([程式開始])
    CallFoo[呼叫 foo(3)]
    FooStart[print("start")]
    ForLoop{for i in range(num)}
    PrintLoop[print("  loop", i)]
    FooEnd[print("end")]
    FooFinish([foo 結束])
    CallA[呼叫 a()]
    PrintA[print('a')]
    End([程式結束])

    Start --> CallFoo
    CallFoo --> FooStart
    FooStart --> ForLoop
    ForLoop -- 是 --> PrintLoop
    PrintLoop --> ForLoop
    ForLoop -- 否 --> FooEnd
    FooEnd --> FooFinish
    FooFinish --> CallA
    CallA --> PrintA
    PrintA --> End
