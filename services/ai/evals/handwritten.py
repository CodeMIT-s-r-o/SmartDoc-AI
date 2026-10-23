"""The 10 hand-written golden items: 5 unanswerable, 2 cross-tenant, 3 follow-ups.

Unanswerable items are "plausible but absent": the topic is near the corpus, but the fact is not
in it (amounts set by other regulations, rules in other acts). That is where a model fills the
gap from its own knowledge, which is the hallucination this set is meant to catch. Evidence
quotes were checked against the ingested text; make eval-generate re-checks them.
"""

from typing import Any

LABOUR = "sk-labour-code-311-2001.pdf"
DATA = "sk-data-protection-act-18-2018.pdf"


def _evidence(document: str, title: str, section: str, page: int, quote: str) -> dict[str, Any]:
    return {
        "document": document,
        "title": title,
        "section": section,
        "pages": [page, page],
        "quote": quote,
    }


def _refuse(id: str, type: str, question: str, why: str) -> dict[str, Any]:
    return {
        "id": id,
        "type": type,
        "question": question,
        "expected": "refuse",
        "answer": why,
        "evidence": [],
    }


HANDWRITTEN: list[dict[str, Any]] = [
    _refuse(
        "h-unans-1",
        "unanswerable",
        "How much is the meal allowance for a business trip lasting 5 to 12 hours?",
        "Not in the corpus: the travel allowances act defines the time zones, but the amounts are "
        "set by a separate ministry measure (models tend to quote the current amount from memory).",
    ),
    _refuse(
        "h-unans-2",
        "unanswerable",
        "What is the minimum monthly wage in Slovakia?",
        "Not in the corpus: the Labour Code refers to the minimum wage but states no amount.",
    ),
    _refuse(
        "h-unans-3",
        "unanswerable",
        "How much sick pay does the employer pay during the first ten days of illness?",
        "Not in the corpus: wage compensation during incapacity is set by another act; the Labour "
        "Code only mentions it.",
    ),
    _refuse(
        "h-unans-4",
        "unanswerable",
        "How long must a password be under the Cybersecurity Act?",
        "Not in the corpus: the act sets no password rules; the only mention of passwords in the "
        "corpus is the data protection act's definition of encryption.",
    ),
    _refuse(
        "h-unans-5",
        "unanswerable",
        "Can I bring my dog to the office?",
        "Out of domain: nothing in the corpus; the relevance gate should refuse without the LLM.",
    ),
    _refuse(
        "h-xten-1",
        "cross_tenant",
        "How long is the Northwind sabbatical?",
        "Only the eval-other tenant's handbook has this; asked as eval-main it must be refused.",
    ),
    _refuse(
        "h-xten-2",
        "cross_tenant",
        "How much is the Northwind bicycle allowance per month?",
        "Only the eval-other tenant's handbook has this; asked as eval-main it must be refused.",
    ),
    {
        "id": "h-follow-1",
        "type": "follow_up",
        "history": [
            {"role": "user", "content": "How long is the basic annual leave?"},
            {"role": "assistant", "content": "The basic leave is at least four weeks [1]."},
        ],
        "question": "And for someone who turns 33 this year?",
        "expected": "answer",
        "answer": "At least five weeks (also for an employee who permanently cares for a child).",
        "evidence": [
            _evidence(
                LABOUR,
                "Act No. 311/2001 Coll., Labour Code",
                "§ 103 Basic vacation allowance",
                58,
                "The leave of an employee who reaches at least 33 years of age by the end of the "
                "relevant calendar year and of an employee who permanently cares for a child shall "
                "be at least five weeks.",
            )
        ],
    },
    {
        "id": "h-follow-2",
        "type": "follow_up",
        "history": [
            {"role": "user", "content": "How long is maternity leave?"},
            {
                "role": "assistant",
                "content": "A woman is entitled to 34 weeks of maternity leave [1].",
            },
        ],
        "question": "And if she gives birth to twins?",
        "expected": "answer",
        "answer": "43 weeks.",
        "evidence": [
            _evidence(
                LABOUR,
                "Act No. 311/2001 Coll., Labour Code",
                "§ 168",
                98,
                "a woman who has given birth to two or more children at the same time is entitled "
                "to maternity leave of 43 weeks",
            )
        ],
    },
    {
        "id": "h-follow-3",
        "type": "follow_up",
        "history": [
            {
                "role": "user",
                "content": "How quickly must a personal data breach be reported to the Office?",
            },
            {
                "role": "assistant",
                "content": "No later than 72 hours after the controller becomes aware of it [1].",
            },
        ],
        "question": "And when do the affected people have to be told?",
        "expected": "answer",
        "answer": (
            "Without undue delay, when the breach is likely to result in a high risk to their "
            "rights and freedoms."
        ),
        "evidence": [
            _evidence(
                DATA,
                "Act No. 18/2018 Coll. on personal data protection",
                "Section 41 Communication of a personal data breach to the data subject",
                25,
                "When the personal data breach is likely to result in a high risk to the rights "
                "and freedoms of natural persons, the controller shall communicate the personal "
                "data breach to the data subject without undue delay.",
            )
        ],
    },
]
