import urllib.request
import urllib.parse
import json
import os
import re
import csv
import threading
import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext

def fetch_ads(make, model, start_date, log_callback=None):
    # Base URL for the Federal Register API
    base_url = "https://www.federalregister.gov/api/v1/articles.json"
    
    query = f'"Airworthiness Directives" "{make}" "{model}"'
    encoded_query = urllib.parse.quote(query)
    
    all_results = []
    page = 1
    
    if log_callback: log_callback(f"Querying Federal Register API...\n")
    
    while True:
        url = (
            f"{base_url}?"
            f"conditions[agencies][]=federal-aviation-administration&"
            f"conditions[type][]=RULE&"
            f"conditions[term]={encoded_query}&"
            f"conditions[publication_date][gte]={start_date}&"
            f"order=newest&"
            f"per_page=100&"
            f"page={page}&"
            f"fields[]=title&fields[]=abstract&fields[]=publication_date&fields[]=pdf_url&fields[]=document_number&fields[]=body_html_url"
        )
        
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req) as response:
                data = json.loads(response.read().decode('utf-8'))
                results = data.get('results', [])
                
                if not results:
                    break
                    
                all_results.extend(results)
                
                total_pages = data.get('total_pages', 1)
                count = data.get('count', 0)
                
                if page == 1 and log_callback:
                    log_callback(f"Found {count} potential matching rules across {total_pages} page(s).\n")
                    
                if log_callback and total_pages > 1:
                    log_callback(f"  - Downloaded page {page} of {total_pages}...\n")
                
                if page >= total_pages:
                    break
                    
                page += 1
        except Exception as e:
            if log_callback: log_callback(f"Error fetching data from Federal Register API (Page {page}): {e}\n")
            break
            
    return all_results

def extract_paragraphs(html_url):
    c_para = "Not found"
    e_para = "Not found"
    b_para = "Not found"
    d_para = "Not found"
    ata_code = "Not found"
    ata_subject = "Not found"
    superseded = "None"
    
    if not html_url:
        return c_para, e_para, ata_code, ata_subject, superseded, b_para, d_para

    def find_para(text, letter, heading):
        """
        Try to find a labelled paragraph in both AD formats:
          Modern (2012+): "(c) Applicability ..."
          Legacy (≤2011): "Applicability (c) ..."
        Returns the captured body text, or None if not found.
        """
        # Modern format: letter then heading inline
        m = re.search(
            r'\(' + letter + r'\)\s*' + re.escape(heading) + r'(.*?)(?=\([a-z]\)\s*[A-Z]|$)',
            text, re.IGNORECASE | re.DOTALL
        )
        if m:
            return m.group(1).strip()

        # Legacy format: heading as a standalone label, then "(letter)" opens the body.
        # Lookahead covers both modern "(x) Heading" and legacy multi-word "Unsafe Condition (x)".
        m = re.search(
            re.escape(heading) + r'\s+\(' + letter + r'\)(.*?)(?=\([a-z]\)\s*[A-Z]|(?:[A-Z][a-zA-Z]* )+\([a-z]\)|$)',
            text, re.IGNORECASE | re.DOTALL
        )
        if m:
            return m.group(1).strip()

        return None
        
    try:
        req = urllib.request.Request(html_url)
        with urllib.request.urlopen(req) as response:
            html_content = response.read().decode('utf-8')
            
            # Strip HTML tags
            text_content = re.sub(r'<[^>]+>', ' ', html_content)
            # Remove redundant whitespaces
            text_content = re.sub(r'\s+', ' ', text_content).strip()
            
            # --- (b) Affected ADs → Superseded ---
            b_para = find_para(text_content, 'b', 'Affected ADs') or "Not found"
            if b_para != "Not found":
                match_idx = b_para.lower().find("replaces")
                if match_idx != -1:
                    after_replaces = b_para[match_idx + len("replaces"):]
                    ad_matches = re.findall(r'AD\s+\d{4}-\d{2}-\d{2}', after_replaces)
                    if ad_matches:
                        unique_ads = list(dict.fromkeys(ad_matches))
                        superseded = ", ".join(unique_ads)

            # --- (d) Subject → ATA Code & Description ---
            d_para = find_para(text_content, 'd', 'Subject') or "Not found"
            if d_para != "Not found":
                ata_match = re.search(r'Code\s+(\d+)[,:]?\s*(.*)', d_para)
                if ata_match:
                    ata_code = ata_match.group(1).strip()
                    raw_subject = ata_match.group(2).strip()
                    # Trim at first full-stop to avoid capturing the next heading
                    dot_pos = raw_subject.find('.')
                    ata_subject = raw_subject[:dot_pos].strip() if dot_pos != -1 else raw_subject.rstrip('.')

            # --- (c) Applicability ---
            result = find_para(text_content, 'c', 'Applicability')
            if result is not None:
                c_para = result
                
            # --- (e) Unsafe Condition ---
            result = find_para(text_content, 'e', 'Unsafe Condition')
            if result is not None:
                e_para = result

    except Exception as e:
        # Silently fail if we can't fetch a specific document
        pass
        
    return c_para, e_para, ata_code, ata_subject, superseded, b_para, d_para


class ADDownloaderApp:
    def __init__(self, root):
        self.root = root
        self.root.title("FAA Airworthiness Directive Downloader")
        self.root.geometry("600x450")
        self.root.minsize(500, 400)
        
        self.create_widgets()

    def create_widgets(self):
        # Input Frame
        input_frame = ttk.LabelFrame(self.root, text="Search Parameters", padding=(10, 10))
        input_frame.pack(fill=tk.X, padx=10, pady=10)
        
        # Make
        ttk.Label(input_frame, text="Aircraft Make:").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.make_var = tk.StringVar(value="Boeing")
        self.make_entry = ttk.Entry(input_frame, textvariable=self.make_var, width=30)
        self.make_entry.grid(row=0, column=1, sticky=tk.W, padx=10, pady=5)
        
        # Model
        ttk.Label(input_frame, text="Aircraft Model:").grid(row=1, column=0, sticky=tk.W, pady=5)
        self.model_var = tk.StringVar(value="747")
        self.model_entry = ttk.Entry(input_frame, textvariable=self.model_var, width=30)
        self.model_entry.grid(row=1, column=1, sticky=tk.W, padx=10, pady=5)
        
        # Start Date
        ttk.Label(input_frame, text="Start Date (YYYY-MM-DD):").grid(row=2, column=0, sticky=tk.W, pady=5)
        self.date_var = tk.StringVar(value="2024-01-01")
        self.date_entry = ttk.Entry(input_frame, textvariable=self.date_var, width=30)
        self.date_entry.grid(row=2, column=1, sticky=tk.W, padx=10, pady=5)
        
        # Run Button
        self.run_btn = ttk.Button(input_frame, text="Download ADs", command=self.start_download)
        self.run_btn.grid(row=3, column=0, columnspan=2, pady=10)
        
        # Output Log Frame
        log_frame = ttk.LabelFrame(self.root, text="Activity Log", padding=(10, 10))
        log_frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=(0, 10))
        
        self.log_text = scrolledtext.ScrolledText(log_frame, wrap=tk.WORD, height=10)
        self.log_text.pack(fill=tk.BOTH, expand=True)

    def log(self, message):
        self.log_text.insert(tk.END, message)
        self.log_text.see(tk.END)
        self.root.update_idletasks()
        
    def start_download(self):
        # Disable button during execution
        self.run_btn.config(state=tk.DISABLED)
        self.log_text.delete(1.0, tk.END)
        
        make = self.make_var.get().strip()
        model = self.model_var.get().strip()
        start_date = self.date_var.get().strip()
        
        if not make or not model or not start_date:
            messagebox.showwarning("Input Error", "Please fill out all fields.")
            self.run_btn.config(state=tk.NORMAL)
            return
            
        self.log(f"Starting search for {make} {model} ADs since {start_date}...\n")
        
        # Run in a background thread to prevent UI freezing
        thread = threading.Thread(target=self.run_download_process, args=(make, model, start_date))
        thread.daemon = True
        thread.start()
        
    def run_download_process(self, make, model, start_date):
        articles = fetch_ads(make, model, start_date, log_callback=self.log)
        
        if not articles:
            self.log("No ADs found or an error occurred during search.\n")
            self.root.after(0, lambda: self.run_btn.config(state=tk.NORMAL))
            return
            
        ad_list = []
        self.log("Filtering and parsing full AD texts (this may take a moment)...\n")
        
        for idx, article in enumerate(articles, 1):
            title = article.get('title', '')
            
            # Ensure it's an Airworthiness Directive for the requested Make
            if 'Airworthiness Directives' in title and make in title:
                abstract = article.get('abstract') or 'No subject provided.'
                subject = abstract.replace('\n', ' ').strip()
                
                pdf_url = article.get('pdf_url', 'No PDF link available.')
                
                document_number = article.get('document_number')
                ad_number = "Unknown AD Number"
                
                if document_number:
                    try:
                        doc_url = f"https://www.federalregister.gov/api/v1/articles/{document_number}.json"
                        doc_req = urllib.request.Request(doc_url)
                        with urllib.request.urlopen(doc_req) as response:
                            doc_data = json.loads(response.read().decode('utf-8'))
                            docket_ids = doc_data.get('docket_ids', [])
                            if isinstance(docket_ids, list):
                                for d in docket_ids:
                                    if d.startswith('AD '):
                                        ad_number = d
                                        break
                    except Exception:
                        pass
                
                html_url = article.get('body_html_url', '')
                c_para, e_para, ata_code, ata_subject, superseded, b_para, d_para = extract_paragraphs(html_url)

                # Skip if the model is not explicitly mentioned in (c) Applicability
                if model not in c_para:
                    self.log(f"  Skipped (model not in Applicability): {ad_number}\n")
                    continue

                ad_list.append({

                    'AD Number': ad_number,
                    'Title': title,
                    'Subject': subject,
                    'Published Date': article.get('publication_date', 'Unknown Date'),
                    'ATA Number': ata_code,
                    'Subject Description': ata_subject,
                    'Superseded ADs': superseded,
                    '(b) Affected ADs': b_para,
                    '(c) Applicability': c_para,
                    '(d) Subject': d_para,
                    '(e) Unsafe Condition': e_para,
                    'PDF Link': f'=HYPERLINK("{pdf_url}", "Open PDF")'
                })
                
                self.log(f"Processed: {ad_number}\n")
        
        if not ad_list:
            self.log(f"No fully matching Airworthiness Directives found for {make} {model}.\n")
            self.root.after(0, lambda: self.run_btn.config(state=tk.NORMAL))
            return
            
        # Sort newest first
        ad_list.sort(key=lambda x: x['Published Date'], reverse=True)
        self.log(f"\nFinal count: {len(ad_list)} ADs matched completely.\n")
        
        # Save to CSV in current working directory
        cwd = os.getcwd()
        base_name = f"AD_download_{make.replace(' ', '')}_{model.replace(' ', '')}"
        csv_filename = f"{base_name}.csv"
        csv_path = os.path.join(cwd, csv_filename)
        # If file already exists, enumerate: base_name(1).csv, base_name(2).csv, ...
        counter = 1
        while os.path.exists(csv_path):
            csv_filename = f"{base_name}({counter}).csv"
            csv_path = os.path.join(cwd, csv_filename)
            counter += 1
        
        try:
            with open(csv_path, 'w', encoding='utf-8-sig', newline='') as f:
                fieldnames = ['AD Number', 'Title', 'Subject', 'Published Date', 'ATA Number', 'Subject Description', 'Superseded ADs', '(b) Affected ADs', '(c) Applicability', '(d) Subject', '(e) Unsafe Condition', 'PDF Link']
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                for ad in ad_list:
                    writer.writerow(ad)
            
            self.log(f"SUCCESS: Saved list to {csv_filename} in the current directory!\n")
            messagebox.showinfo("Success", f"Found {len(ad_list)} ADs.\nSaved to:\n{csv_path}")
        except Exception as e:
            self.log(f"ERROR: Failed to save CSV file to {csv_path}. Details: {e}\n")
            messagebox.showerror("Error", f"Failed to save CSV file:\n{e}")
            
        # Re-enable button
        self.root.after(0, lambda: self.run_btn.config(state=tk.NORMAL))

def main():
    root = tk.Tk()
    app = ADDownloaderApp(root)
    # Ensure window appears on top when executing scripts sometimes
    root.lift()
    root.attributes('-topmost',True)
    root.after_idle(root.attributes,'-topmost',False)
    root.mainloop()

if __name__ == "__main__":
    main()
