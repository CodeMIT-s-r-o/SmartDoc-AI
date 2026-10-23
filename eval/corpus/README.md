# Eval corpus

Five Slovak acts in English (see [LICENSES.md](LICENSES.md)). The PDFs are not committed; get
them by hand, save them here under the exact file names, then run `make corpus-check`.

| Save as | Get it from |
|---|---|
| `sk-labour-code-311-2001.pdf` | [ILO NATLEX, Labour Code](https://natlex.ilo.org/dyn/natlex2/r/natlex/fe/details?p3_isn=61871): the English PDF, version effective from 17.04.2025 |
| `sk-travel-allowances-283-2002.pdf` | [ILO NATLEX, Act 283/2002](https://natlex.ilo.org/dyn/natlex2/r/natlex/fe/details?p3_isn=62145): the English PDF, version effective from 01.01.2025 |
| `sk-data-protection-act-18-2018.pdf` | [dataprotection.gov.sk](https://dataprotection.gov.sk/files/personal-data-sample/2019_10_03_act_18_2018_on_personal_data_protection_and_amending_and_supplementing_certain_acts.pdf) |
| `sk-cybersecurity-act-69-2018.pdf` | [sk-cert.sk](https://www.sk-cert.sk/wp-content/uploads/2018/03/2018_69-Act-on-Cybersecurity.pdf) |
| `sk-osh-act-124-2006.pdf` | [ip.gov.sk](https://www.ip.gov.sk/files/en/legislation/sk-legislation/legislation/act-no-124_2006-effect-from-01-01-2022.pdf) |

NATLEX runs a browser check against bots, so its two files cannot be fetched by a script. If a
source publishes a newer version, the hash check fails: update `manifest.json` deliberately,
because the eval datasets cite pages of these exact files.
