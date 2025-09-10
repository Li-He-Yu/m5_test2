#include <stdio.h>
#define opr(a, b, c) printf("%d" #b "%d=%d\n", a, c, (a b c))
int main(void){
    int a, b;
    while(scanf("%d %d", &a, &b) != EOF){
        opr(a, +, b);
        opr(a, *, b);
        opr(a, -, b);
        if(a%b < 0)
            printf("%d/%d=%d...%d\n", a, b, (a/b)-1, (a%b)+b);
        else
            printf("%d/%d=%d...%d\n", a, b, (a/b), (a%b));
    }
    return 0;
}