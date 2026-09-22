import os
import sys
import time
from pathlib import Path

# Add backend to path so we can import studio modules
backend_dir = Path(__file__).parent.parent / "backend"
sys.path.insert(0, str(backend_dir))

from studio.api.state import get_state
from studio.chat.agent import chat

def run_bench(questions):
    st = get_state()
    # Force settings to use gemini
    st.settings.set("llm.provider", "gemini")
    st.settings.set("llm.model", "gemini-3.5-flash-lite")
    # clear chat model override so it uses the above
    st.settings.set("llm.chat_model", "")
    
    api_key = os.environ.get("ALETHEIA_LLM_API_KEY", "")
    if api_key:
        st.settings.set("llm.api_key", api_key)
    
    print("Testing Lyra performance with Gemini...")
    total_time = 0
    for idx, q in enumerate(questions):
        print(f"\nQ{idx+1}: {q}")
        start_time = time.time()
        
        # We need a new session context, so we just pass the new message
        messages = [{"role": "user", "content": q}]
        result = chat(messages)
        
        elapsed = time.time() - start_time
        total_time += elapsed
        
        if result.get("available"):
            answer = result.get("answer", "").strip()
            print(f"Time: {elapsed:.2f}s | Response: {answer[:100]}...")
        else:
            print(f"Time: {elapsed:.2f}s | Error: {result.get('answer')}")
            
    avg_time = total_time / len(questions) if questions else 0
    print(f"\nAverage Response Time: {avg_time:.2f}s")

if __name__ == "__main__":
    test_questions = [
        "How many events were ingested?",
        "What are the top 5 source IPs?",
        "Which packs are installed?"
    ]
    run_bench(test_questions)
