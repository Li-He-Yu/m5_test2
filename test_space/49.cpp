#include <iostream>
#include <vector>
using namespace std;

long long int gen_cont_1(const int digit);
bool check_mod(long long int to_check, long long int cont_1);
void suc_pro(int &digit, int &index_of_arr);
void fail_pro(int &digit);

int main(void){
    // input
    int nums;
    cin >> nums;

    int num_array[nums];
    for(int i=0; i<nums; i++){
        cin >> num_array[i];
    }


    // procedure
    // 1. generate 1~111..11 to check
    // 2. num_array[i] mod it is 0
    int digit = 1;
    int check_index = 0;
    while(check_index < nums){
        long long int cont_1 = (long long int) gen_cont_1(digit);
        int to_check = num_array[check_index];


        while(true){
            cout << "test\n";
            if(check_mod(to_check, cont_1)){
                // 1. print digit, and digit = 1
                // 2. check next num
                suc_pro(digit, check_index);
                break;
            }
            else{
                // check one more digit
                fail_pro(digit);
            }
        }
    }

    return 0;
}

long long int gen_cont_1(const int digit){
    // using static long long vector to store generate result
    static vector<long long int> vec_llint({1, 11, 111, 1111, 11111,
        111111, 1111111, 11111111, 111111111, 1111111111});
    int vec_size = 10;

    if(digit > vec_size){
        for(int i = (vec_size - 1); i < digit; i++){
            vec_llint.push_back(vec_llint[i] *10 +1);
            vec_size++;
        }
    }

    return vec_llint[digit -1];
}

bool check_mod(long long int to_check, long long int cont_1){
    if(cont_1 % to_check == 0)
        return true;
    else
        return false;
}

void suc_pro(int &digit, int &index_of_arr){
    cout << digit << "\n";
    digit = 1, index_of_arr++;
}

void fail_pro(int &digit){
    digit++;
}